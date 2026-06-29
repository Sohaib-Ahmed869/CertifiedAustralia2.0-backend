const Ticket = require('../models/Ticket');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');
const appEmails = require('./applicationEmailService');

const ticketCrud = buildCrud(Ticket, {
  populate: ['requesterId', 'assignedTo', 'applicationId', 'messages.senderId'],
});

const generateTicketId = async () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const suffix = String(10000 + Math.floor(Math.random() * 90000));
    const ticketId = `TKT${suffix}`;
    const existing = await Ticket.exists({ ticketId });
    if (!existing) return ticketId;
  }
  throw new AppError('Unable to generate ticket ID', 500);
};

const createTicket = async (data) => {
  const ticketId = await generateTicketId();

  const ticket = await Ticket.create({
    ...data,
    ticketId,
    status: 'open',
    messages: data.description
      ? [
          {
            content: data.description,
            senderId: data.requesterId,
            senderRole: data.senderRole || 'requester',
            attachments: data.attachments || [],
            createdAt: new Date(),
          },
        ]
      : [],
  });

  return Ticket.findById(ticket._id)
    .populate('requesterId assignedTo applicationId messages.senderId')
    .lean();
};

const addMessage = async (ticketId, messageData) => {
  const ticket = await Ticket.findById(ticketId);
  if (!ticket) throw new AppError('Ticket not found', 404);

  ticket.messages.push({
    content: messageData.content,
    senderId: messageData.senderId,
    senderRole: messageData.senderRole,
    isInternal: messageData.isInternal || false,
    attachments: messageData.attachments || [],
    createdAt: new Date(),
  });

  // Track first response (from support agent)
  if (!ticket.firstResponseAt && messageData.senderRole !== 'requester') {
    ticket.firstResponseAt = new Date();
  }

  // If support agent replies, move to in_progress
  if (ticket.status === 'open' && messageData.senderRole !== 'requester') {
    ticket.status = 'in_progress';
  }

  // If requester replies on a waiting ticket, move back to in_progress
  if (ticket.status === 'waiting_on_customer' && messageData.senderRole === 'requester') {
    ticket.status = 'in_progress';
  }

  await ticket.save();

  // Notify the other party (non-fatal)
  try {
    const { createNotification } = require('./notificationService');
    if (messageData.senderRole === 'requester' && ticket.assignedTo) {
      // Student replied — notify support agent
      await createNotification({
        userId: ticket.assignedTo,
        type: 'ticket_update',
        title: 'New Ticket Reply',
        message: `${ticket.ticketId}: The requester has replied.`,
        link: `/support/tickets`,
        relatedId: ticket._id,
      });
    } else if (messageData.senderRole !== 'requester' && ticket.requesterId && !messageData.isInternal) {
      // Support replied — notify requester
      await createNotification({
        userId: ticket.requesterId,
        type: 'ticket_update',
        title: 'Support Response',
        message: `You have a new response on ticket ${ticket.ticketId}.`,
        link: `/student/support`,
        relatedId: ticket._id,
      });

      // Send email to student
      try {
        const User = require('../models/User');
        const student = await User.findById(ticket.requesterId).select('firstName email').lean();
        if (student?.email) {
          appEmails.sendSupportTicketReplyEmail(student, ticket)
            .catch((e) => console.error('[TicketService] Ticket reply email error:', e.message));
        }
      } catch (emailErr) {
        console.error('[TicketService] Failed to fetch student for reply email:', emailErr.message);
      }
    }
  } catch (err) {
    console.error('[TicketService] Failed to create message notification:', err.message);
  }

  return Ticket.findById(ticket._id)
    .populate('requesterId assignedTo applicationId messages.senderId')
    .lean();
};

const resolveTicket = async (ticketId, userId, finalMessage) => {
  const ticket = await Ticket.findById(ticketId);
  if (!ticket) throw new AppError('Ticket not found', 404);

  if (finalMessage) {
    ticket.messages.push({
      content: finalMessage,
      senderId: userId,
      senderRole: 'support',
      createdAt: new Date(),
    });
  }

  ticket.status = 'resolved';
  ticket.resolvedAt = new Date();

  if (!ticket.firstResponseAt) {
    ticket.firstResponseAt = new Date();
  }

  await ticket.save();

  // Notify requester that ticket is resolved (non-fatal)
  if (ticket.requesterId) {
    try {
      const { createNotification } = require('./notificationService');
      await createNotification({
        userId: ticket.requesterId,
        type: 'ticket_update',
        title: 'Ticket Resolved',
        message: `Your ticket ${ticket.ticketId} has been resolved.`,
        link: `/student/support`,
        relatedId: ticket._id,
      });
    } catch (err) {
      console.error('[TicketService] Failed to create resolve notification:', err.message);
    }
  }

  return Ticket.findById(ticket._id)
    .populate('requesterId assignedTo applicationId messages.senderId')
    .lean();
};

const getStats = async (userId) => {
  const [agentStats, teamStats] = await Promise.all([
    // Agent-specific stats
    Ticket.aggregate([
      { $match: userId ? { assignedTo: userId } : {} },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]),
    // Overall stats
    Ticket.aggregate([
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          avgResponseTime: [
            { $match: { firstResponseAt: { $exists: true } } },
            {
              $group: {
                _id: null,
                avg: {
                  $avg: { $subtract: ['$firstResponseAt', '$createdAt'] },
                },
              },
            },
          ],
          avgResolutionTime: [
            { $match: { resolvedAt: { $exists: true } } },
            {
              $group: {
                _id: null,
                avg: {
                  $avg: { $subtract: ['$resolvedAt', '$createdAt'] },
                },
              },
            },
          ],
          resolvedToday: [
            {
              $match: {
                resolvedAt: {
                  $gte: new Date(new Date().setHours(0, 0, 0, 0)),
                },
              },
            },
            { $count: 'count' },
          ],
        },
      },
    ]),
  ]);

  const statusMap = {};
  agentStats.forEach(({ _id, count }) => {
    statusMap[_id] = count;
  });

  const team = teamStats[0] || {};
  const teamStatusMap = {};
  (team.byStatus || []).forEach(({ _id, count }) => {
    teamStatusMap[_id] = count;
  });

  return {
    agent: {
      byStatus: statusMap,
      open: (statusMap.open || 0) + (statusMap.in_progress || 0),
      resolved: statusMap.resolved || 0,
      total: Object.values(statusMap).reduce((sum, c) => sum + c, 0),
    },
    team: {
      byStatus: teamStatusMap,
      avgResponseTimeMs: team.avgResponseTime?.[0]?.avg || 0,
      avgResolutionTimeMs: team.avgResolutionTime?.[0]?.avg || 0,
      resolvedToday: team.resolvedToday?.[0]?.count || 0,
      total: Object.values(teamStatusMap).reduce((sum, c) => sum + c, 0),
    },
  };
};

module.exports = {
  tickets: ticketCrud,
  createTicket,
  addMessage,
  resolveTicket,
  getStats,
};

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const protect = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError('Not authenticated', 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) throw new AppError('User no longer exists', 401);
    if (user.status !== 'active') throw new AppError('Account is deactivated', 403);

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new AppError('Token expired', 401);
    if (err.name === 'JsonWebTokenError') throw new AppError('Invalid token', 401);
    throw err;
  }
});

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    throw new AppError('Not authorized for this action', 403);
  }
  next();
};

module.exports = { protect, authorize };

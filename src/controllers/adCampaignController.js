const fs = require('fs');
const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/adCampaignService');
const driveService = require('../services/googleDriveService');

const cleanupFile = (filePath) => { if (filePath) fs.unlink(filePath, () => {}); };

/** A 1×1 transparent GIF — what a campaign with no usable creative resolves to. */
const BLANK_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

module.exports = {
  /**
   * Campaigns, optionally narrowed to one platform. `activeOnly=true` is for the
   * pickers that START new attribution; reporting must not pass it, or a
   * finished campaign's leads drop out of the numbers.
   */
  list: asyncHandler(async (req, res) => {
    const items = await service.list({
      sourceKey: req.query.sourceKey,
      activeOnly: req.query.activeOnly === 'true',
    });
    res.status(200).json({ items });
  }),

  /**
   * `{ key, name, sourceKey }` for every campaign, unauthenticated.
   *
   * The public RegisterPage is the caller: a lead arriving on
   * `?source=…&campaign=…` needs the campaign resolved to its real platform
   * before the page can decide whether to ask "How did you hear about us?".
   */
  publicList: asyncHandler(async (req, res) => {
    const items = await service.listPublic();
    res.status(200).json({ items });
  }),

  create: asyncHandler(async (req, res) => {
    const item = await service.create(req.body, req.user?._id);
    res.status(201).json({ item });
  }),

  update: asyncHandler(async (req, res) => {
    const item = await service.update(req.params.id, req.body);
    res.status(200).json({ item });
  }),

  remove: asyncHandler(async (req, res) => {
    const result = await service.remove(req.params.id);
    res.status(200).json(result);
  }),

  /**
   * Upload / replace the ad creative. The temp file multer wrote is removed on
   * BOTH paths — a rejected image (wrong type, too large) would otherwise leave
   * the upload sitting in the OS temp directory.
   */
  uploadImage: asyncHandler(async (req, res) => {
    try {
      const item = await service.setImage(req.params.id, req.file);
      res.status(200).json({ item });
    } finally {
      cleanupFile(req.file?.path);
    }
  }),

  removeImage: asyncHandler(async (req, res) => {
    const item = await service.clearImage(req.params.id);
    res.status(200).json({ item });
  }),

  /**
   * Stream the ad creative through the portal, via the Drive service account.
   *
   * WHY NOT LINK STRAIGHT TO DRIVE. `drive.google.com/thumbnail?id=…` only
   * renders for a browser Google is willing to serve it to: it depends on the
   * file's link-sharing surviving, on the Shared Drive not restricting
   * download/copy, and on whatever Google account the staff member happens to
   * be signed into having access. It fetches fine from a server (curl gets a
   * 200) and still shows a broken image in the browser, which is exactly the
   * failure this replaces. Serving it ourselves depends on none of that.
   *
   * DELIBERATELY UNAUTHENTICATED, and it has to be: this URL is the `src` of an
   * `<img>`, and an image request cannot carry an Authorization header. The
   * exposure is an ad creative — a picture already being shown to the public
   * internet as an advertisement — reachable only by guessing a campaign key,
   * and it reveals nothing about students or the business.
   *
   * A missing campaign or missing creative answers a 1×1 GIF, not a 404: the
   * caller is an `<img>` tag, and a broken-image glyph is worse than nothing.
   */
  serveImage: asyncHandler(async (req, res) => {
    const campaign = await service.findByIdOrKey(req.params.id);
    const fileId = campaign?.image?.fileId;
    if (!fileId) {
      res.setHeader('Content-Type', 'image/gif');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).send(BLANK_GIF);
    }
    // Creatives are immutable once uploaded — replacing one writes a NEW Drive
    // file id — so this can be cached hard. `immutable` stops the revalidation
    // round trip on every card render.
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    try {
      return await driveService.streamDriveFileToResponse(fileId, res, true);
    } catch (err) {
      // Drive failed after headers may already be out; fall back to the blank
      // pixel only if we can still write a response.
      if (res.headersSent) return undefined;
      res.setHeader('Content-Type', 'image/gif');
      return res.status(200).send(BLANK_GIF);
    }
  }),
};

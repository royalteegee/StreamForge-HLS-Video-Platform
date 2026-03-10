/**
 * Middleware to verify that the webhook request is coming from our Lambda,
 * not from an unknown caller. Checks the x-webhook-secret header.
 */
function verifyWebhookSecret(req, res, next) {
  const incomingSecret = req.headers["x-webhook-secret"];
  const expectedSecret = process.env.WEBHOOK_SECRET;

  if (!expectedSecret) {
    console.error("WEBHOOK_SECRET env variable is not set!");
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  if (!incomingSecret || incomingSecret !== expectedSecret) {
    console.warn("Unauthorized webhook attempt from:", req.ip);
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

module.exports = { verifyWebhookSecret };
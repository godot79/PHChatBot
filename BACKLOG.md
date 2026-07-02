# Backlog

## Fix `verifyWebhookSignature` to be Meta-compatible middleware

**Priority:** Medium — current `checkSignature` approach works correctly; this is a structural improvement.

**Context:**  
`SecurityMiddleware.verifyWebhookSignature` returns `401`/`500` on failure, which causes Meta to retry the webhook indefinitely. The current workaround is a post-ack boolean check (`checkSignature`) called inside the handler after `res.sendStatus(200)`.

**Proposed fix:**  
Restructure `verifyWebhookSignature` to always ack `200` first, then call `next()` only on valid signature. Wire it as Express middleware before the POST handler. Remove the inline `res.sendStatus(200)` + `checkSignature` call from the handler.

```diff
// SecurityMiddleware.js — verifyWebhookSignature
+  res.sendStatus(200); // always ack Meta first — 4xx causes indefinite retries
+  const valid = this.checkSignature(req.body, req.get('X-Hub-Signature-256'));
+  if (!valid) {
+    this.logger.warn('WEBHOOK_SIG_DROP', { ip: req.ip });
+    return;
+  }
+  next();

// webhook.js — remove inline ack + boolean check from handler body
-  res.sendStatus(200);
-  if (!securityMiddleware.checkSignature(rawBody, sigHeader)) { ... return; }

// webhook.js — wire middleware into route
-  router.post('/', rateLimiter.getWhatsappLimiter(), async (req, res) => {
+  router.post('/', rateLimiter.getWhatsappLimiter(),
+    securityMiddleware.verifyWebhookSignature.bind(securityMiddleware),
+    async (req, res) => {
```

**Files to change:**
- `src/middleware/SecurityMiddleware.js`
- `src/routes/webhook.js`

**Note:** `checkSignature` stays as the shared HMAC utility — no duplication.

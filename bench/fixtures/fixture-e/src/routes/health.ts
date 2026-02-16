import { Router } from "express";

const router = Router();

// GET /health — health check
router.get("/", (req, res) => {
  res.json({ status: "ok" });
});

export default router;

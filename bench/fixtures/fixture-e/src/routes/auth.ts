import { Router } from "express";

const router = Router();

// POST /api/auth/login
router.post("/login", (req, res) => {
  res.json({ token: "fake-jwt" });
});

// POST /api/auth/register
router.post("/register", (req, res) => {
  res.status(201).json({ id: 1 });
});

// POST /api/auth/refresh
router.post("/refresh", (req, res) => {
  res.json({ token: "new-fake-jwt" });
});

export default router;

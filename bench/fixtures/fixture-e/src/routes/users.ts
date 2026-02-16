import { Router } from "express";

const router = Router();

// GET /api/users — list all users
router.get("/", (req, res) => {
  res.json([]);
});

// GET /api/users/:id — get user by ID
router.get("/:id", (req, res) => {
  res.json({ id: req.params.id });
});

// POST /api/users — create user
router.post("/", (req, res) => {
  res.status(201).json(req.body);
});

// PUT /api/users/:id — update user
router.put("/:id", (req, res) => {
  res.json({ id: req.params.id, ...req.body });
});

// DELETE /api/users/:id — delete user
router.delete("/:id", (req, res) => {
  res.status(204).send();
});

export default router;

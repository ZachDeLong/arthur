import express from "express";
import usersRouter from "./routes/users.js";
import authRouter from "./routes/auth.js";
import healthRouter from "./routes/health.js";

const app = express();

app.use(express.json());

// Mount routers
app.use("/api/users", usersRouter);
app.use("/api/auth", authRouter);
app.use("/health", healthRouter);

// Direct route on app
app.get("/api/status", (req, res) => {
  res.json({ version: "1.0.0" });
});

export default app;

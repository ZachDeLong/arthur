/**
 * Barrel import — importing this file registers all checkers with the registry.
 * Import order determines the order checkers run in check_all.
 */
import "./paths.js";
import "./schema.js";
import "./sql-schema.js";
import "./imports.js";
import "./env.js";
import "./routes.js";
import "./supabase-schema.js";
import "./express-routes.js";
import "./package-api.js";

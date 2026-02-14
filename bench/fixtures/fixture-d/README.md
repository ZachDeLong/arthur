# Engagement Tracker

A content engagement tracking platform built with Drizzle ORM and PostgreSQL. Users can publish posts, and other users can interact with them through various engagement types (likes, comments, shares).

## Architecture

The platform uses Drizzle ORM for type-safe database access. The schema is defined in `src/db/schema.ts` and SQL migrations live in `migrations/`.

## Data Model

- **Users** — registered accounts with usernames and emails
- **Posts** — content published by users with titles and body text
- **Interactions** — user engagements with posts (likes, comments, shares)

Each user has a unique username and email. Posts belong to a single author and can receive multiple interactions from different users.

## API

The API exposes RESTful endpoints for managing users, posts, and interactions. Common queries include:

- Get all posts by a user
- Get the top posts ranked by total interactions
- Get a user's interaction history
- Aggregate interaction counts per post

## Environment

Configuration is managed through environment variables. The database connection string and application secrets are set via `.env` files.

## Getting Started

1. Install dependencies: `npm install`
2. Set up your `.env` file with the database connection string
3. Run migrations: `npm run migrate`
4. Start the server: `npm start`

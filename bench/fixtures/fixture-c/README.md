# Engagement Platform

A Next.js application for managing participants and their content interactions. Built with Prisma for data access and TypeScript throughout.

## Architecture

The platform centers around three main concepts:

- **Participants** — people who use the platform, each with a display identifier and contact details. Participants belong to a tier that determines their access level.
- **Content Items** — articles or posts authored by participants. Each content item has a headline, body, and content category. Items can be toggled between visible and hidden states.
- **Engagements** — records of when a participant interacts with a content item. Each engagement captures what kind of interaction occurred and when it happened.

The relationship between participants and content is dual: a participant can _author_ content items, and also _engage_ with content items created by others. These are tracked separately.

## Tech Stack

- **Next.js 14** (App Router, server components by default)
- **Prisma** for database access (PostgreSQL)
- **TypeScript** everywhere

## Data Model

Participants have a tiered access system. Content items are organized by category. The engagement system tracks different kinds of interactions (views, bookmarks, shares) between participants and content.

The join between participants and content through engagements includes metadata about the interaction — what kind it was and when it occurred. A participant's authored content is a separate, direct relationship.

## Development

1. Copy `.env.example` to `.env` and configure your database URL
2. Run `npx prisma db push` to sync the schema
3. Run `npm run dev` to start the development server

## API Routes

- `GET/POST /api/participants` — list and create participants
- `GET/POST /api/content` — list and create content items

Server components fetch data directly via Prisma. Client components handle interactive UI elements.

# Getting Started

Welcome to the Devkit Node API. This guide walks you through running the
backend locally and making your first API call.

## Prerequisites

- **Node.js** 22+ and npm
- **MongoDB** running locally or accessible via a connection string
- **Git** for cloning the repository

## Setup

1. Clone the Node backend repository.
2. Copy `.env.example` to `.env` and fill in your values (mongo URI, JWT
   secret, mail provider, etc.).
3. Install dependencies:

```bash
npm install
```

4. Start the development server:

```bash
npm run dev
```

The API listens on `http://localhost:3000` by default.

## Your first API call

Once the server is running, verify it responds:

```bash
curl http://localhost:3000/api/core/status
```

You should receive a JSON response confirming the server is healthy.

## Explore the API

- **Authentication** — sign up, log in, and manage tokens
- **Organizations** — create teams and manage roles
- Browse the endpoint reference in the sidebar for full request/response
  schemas and interactive examples

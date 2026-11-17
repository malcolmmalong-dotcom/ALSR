# ALSR service request backend

This project uses the Node.js server in `server.js`. The empty `forms.php` file is not part of the request flow.

## Run locally

Requires Node.js 22 or newer. From this folder, run:

```sh
npm start
```

Open `http://localhost:3000`. Set the `PORT` environment variable to use another port.

## Supabase data storage

Set `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY` to store submissions in Supabase instead of local files. Apply the SQL in `supabase/migrations/20261117000000_service_requests.sql` in the Supabase SQL Editor first. It creates a private `service-request-photos` bucket and a `service_requests` table; browser roles have no access to the personal data. If both Supabase variables are unset, local development stores requests under `submissions/` as before. Never expose the service-role key in browser code or commit it.

## Email delivery

Requests are emailed to `malcolmmalong@gmail.com` after they are saved. The default sender connection is Gmail SMTP. Before starting the server, copy `.env.example` to `.env` and set `SMTP_USER` and `SMTP_PASS` to the sending Gmail account and its Google App Password. Use an App Password rather than your normal Google password. `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, and `EMAIL_TO` can be overridden in `.env` for another SMTP provider or recipient. Keep `.env` private; it is excluded from version control.

If SMTP credentials are missing or delivery fails, the form reports that the email could not be sent and retains the request in Supabase (or under `submissions/` in local mode) for recovery.

## API

- `GET /api/health` returns `{"status":"ok"}`.
- `POST /api/service-requests` accepts the multipart form from `SPARE.html`.
- Opening GET /api/service-requests directly does not send a request; it returns instructions to use the form at /. Form submissions use POST so contact details are not placed in the URL.

Required fields are `name`, `phone`, `email`, `service`, and `problem`. Optional fields are `location`, `availability`, and up to five vehicle photos. Requests are limited to 15 MB total. Supported photo formats are JPG, PNG, WEBP, GIF, and HEIC; image signatures are checked before saving.

Successful submissions return a confirmation page. In local mode each request is saved under `submissions/<request-id>/request.json` with photos alongside it. With Supabase configured, records and photos are stored there instead. The `submissions/` folder is excluded from version control.

The API intentionally has no public endpoint for reading submissions, since records contain personal contact information.

## Hosting

Supabase stores the records and photos; it does not run this long-lived Node server. `render.yaml` configures the Node web service for Render. Push this repository to GitHub, create a Render Web Service from the repository using the Blueprint, and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SMTP_USER`, and `SMTP_PASS` in Render's environment settings. The form and its API are served from the same Node service. See [Render's Node deployment guide](https://render.com/docs/deploy-node-express-app) and [environment variable guide](https://render.com/docs/configure-environment-variables).
"# ALSR" 
"# Malong-site-" 

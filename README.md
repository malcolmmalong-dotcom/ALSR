# ALSR service request backend

This project uses the Node.js server in `server.js`. The empty `forms.php` file is not part of the request flow.

## Run locally

Requires Node.js 22 or newer. From this folder, run:

```sh
npm start
```

Open `http://localhost:3000`. Set the `PORT` environment variable to use another port.

## Supabase data storage

Set `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY` to store submissions in Supabase instead of local files. Apply the SQL migrations in `supabase/migrations/` in timestamp order in the Supabase SQL Editor before deploying. It creates a private `service-request-photos` bucket and a `service_requests` table; browser roles have no access to the personal data. If both Supabase variables are unset, local development stores requests under `submissions/` as before. Never expose the service-role key in browser code or commit it.

## Email delivery

Requests are emailed to `malcolmmalong@gmail.com` after they are saved. The default sender connection is Gmail SMTP. Before starting the server, copy `.env.example` to `.env` and set `SMTP_USER` and `SMTP_PASS` to the sending Gmail account and its Google App Password. Use an App Password rather than your normal Google password. `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, and `EMAIL_TO` can be overridden in `.env` for another SMTP provider or recipient. Keep `.env` private; it is excluded from version control.

If SMTP configuration is missing or rejected, the form reports that the request was saved and includes its request ID. Requests also record an email status (`pending`, `sending`, `accepted`, `failed`, or `unknown`). `accepted` means the SMTP server accepted the message; it does not prove inbox delivery. Network errors can have an uncertain outcome, so the form does not retry automatically. Use the request ID and saved record to investigate before any manual resend.

Run `npm run email:check` locally to verify SMTP connectivity and authentication without sending an email. It never prints credential values. A successful check does not prove that a message reached the recipient's inbox. In production, review Render logs for the request ID and safe error code, and check the recipient mailbox's spam folder and any bounce notices.
Run `npm run email:issues` to list saved requests whose email status needs review; it prints request IDs, statuses, and safe error codes, never contact details, and sends no email. Local records are under `submissions/<request-id>/request.json`; Supabase records are in `service_requests`. Review `failed` and `unknown` records before any manual resend. `unknown` means the SMTP connection ended before acceptance could be confirmed, so check the recipient mailbox and provider logs first.

## API

- `GET /api/health` returns `{"status":"ok"}`.
- `POST /api/service-requests` accepts the multipart form from `SPARE.html`.
- Opening GET /api/service-requests directly does not send a request; it returns instructions to use the form at /. Form submissions use POST so contact details are not placed in the URL.

Required fields are `name`, `phone`, `email`, `service`, and `problem`. Optional fields are `location`, `mileage` (whole kilometres from 0 to 9,999,999), `availability`, and up to five vehicle photos. Requests are limited to 15 MB total. Supported photo formats are JPG, PNG, WEBP, GIF, and HEIC; image signatures are checked before saving.

Successful submissions return a confirmation page. In local mode each request is saved under `submissions/<request-id>/request.json` with photos alongside it. With Supabase configured, records and photos are stored there instead. The `submissions/` folder is excluded from version control.

The API intentionally has no public endpoint for reading submissions, since records contain personal contact information.

## Hosting

Supabase stores the records and photos; it does not run this long-lived Node server. `render.yaml` configures the Node web service for Render. Push this repository to GitHub, create a Render Web Service from the repository using the Blueprint, and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SMTP_USER`, and `SMTP_PASS` in Render's environment settings. The form and its API are served from the same Node service. See [Render's Node deployment guide](https://render.com/docs/deploy-node-express-app) and [environment variable guide](https://render.com/docs/configure-environment-variables).
"# ALSR" 
"# Malong-site-" 

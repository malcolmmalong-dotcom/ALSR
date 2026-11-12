# ALSR service request backend

This project uses the Node.js server in `server.js`. The empty `forms.php` file is not part of the request flow.

## Run locally

Requires Node.js 18 or newer. From this folder, run:

```sh
npm start
```

Open `http://localhost:3000`. Set the `PORT` environment variable to use another port.

## Email delivery

Requests are emailed to `malcolmmalong@gmail.com` after they are saved. The default sender connection is Gmail SMTP. Before starting the server, copy `.env.example` to `.env` and set `SMTP_USER` and `SMTP_PASS` to the sending Gmail account and its Google App Password. Use an App Password rather than your normal Google password. `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, and `EMAIL_TO` can be overridden in `.env` for another SMTP provider or recipient. Keep `.env` private; it is excluded from version control.

If SMTP credentials are missing or delivery fails, the form reports that the email could not be sent and retains the request under `submissions/` for recovery.

## API

- `GET /api/health` returns `{"status":"ok"}`.
- `POST /api/service-requests` accepts the multipart form from `SPARE.html`.
- Opening GET /api/service-requests directly does not send a request; it returns instructions to use the form at /. Form submissions use POST so contact details are not placed in the URL.

Required fields are `name`, `phone`, `email`, `service`, and `problem`. Optional fields are `location`, `availability`, and up to five vehicle photos. Requests are limited to 15 MB total. Supported photo formats are JPG, PNG, WEBP, GIF, and HEIC; image signatures are checked before saving.

Successful submissions return a confirmation page. Each request is saved under `submissions/<request-id>/request.json`; photos are stored alongside it. The `submissions/` folder is excluded from version control. Back it up with the rest of the business records.

The API intentionally has no public endpoint for reading submissions, since records contain personal contact information.
"# ALSR" 

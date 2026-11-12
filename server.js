'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config();
const nodemailer = require('nodemailer');

const ROOT = __dirname;
const UPLOAD_ROOT = path.join(ROOT, 'submissions');
const PORT = Number(process.env.PORT) || 3000;
const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
const MAX_PHOTOS = 5;
const MAX_FIELD_LENGTHS = { name: 120, phone: 40, email: 254, service: 40, location: 200, problem: 5000, availability: 200 };
const SERVICES = new Set(['repair', 'maintenance', 'installation', 'inspection', 'other']);
const IMAGE_TYPES = {
    '.jpg': { mime: 'image/jpeg', check: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    '.jpeg': { mime: 'image/jpeg', check: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    '.png': { mime: 'image/png', check: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
    '.gif': { mime: 'image/gif', check: b => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii')) },
    '.webp': { mime: 'image/webp', check: b => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
    '.heic': { mime: 'image/heic', check: b => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && /heic|heix|hevc|mif1/.test(b.toString('ascii', 8, 16)) },
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function parseMultipart(body, boundary) {
    const delimiter = Buffer.from(`--${boundary}`);
    const parts = [];
    let cursor = body.indexOf(delimiter);
    while (cursor !== -1) {
        cursor += delimiter.length;
        if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break;
        if (body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) cursor += 2;
        const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
        if (headerEnd === -1) throw new Error('Malformed multipart headers.');
        const headers = body.subarray(cursor, headerEnd).toString('utf8');
        const next = body.indexOf(delimiter, headerEnd + 4);
        if (next === -1) throw new Error('Malformed multipart body.');
        let dataEnd = next;
        if (body.subarray(dataEnd - 2, dataEnd).equals(Buffer.from('\r\n'))) dataEnd -= 2;
        const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
        const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1];
        const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
        if (name) parts.push({ name, filename, data: body.subarray(headerEnd + 4, dataEnd) });
        cursor = next;
    }
    return parts;
}

async function readRequest(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
            const error = new Error('Submission is too large. The total upload limit is 15 MB.');
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function validateFields(fields) {
    for (const [key, max] of Object.entries(MAX_FIELD_LENGTHS)) {
        if (fields[key] && fields[key].length > max) return `${key} is too long (maximum ${max} characters).`;
    }
    for (const key of ['name', 'phone', 'email', 'service', 'problem']) {
        if (!fields[key]) return 'Please complete all required fields.';
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return 'Please enter a valid email address.';
    if (!SERVICES.has(fields.service)) return 'Please select a valid service.';
    return null;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function handleSubmission(req, res) {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!contentType.toLowerCase().startsWith('multipart/form-data') || !boundaryMatch) {
        return send(res, 400, 'Expected a multipart form submission.');
    }
    const boundary = (boundaryMatch[1] || boundaryMatch[2]).trim();
    if (!boundary || boundary.length > 200) return send(res, 400, 'Invalid multipart boundary.');
    let parts;
    try {
        parts = parseMultipart(await readRequest(req), boundary);
    } catch (error) {
        if (error.status === 413) return send(res, 413, error.message);
        return send(res, 400, error.message);
    }

    const fields = {};
    const photos = [];
    const allowedFields = new Set(Object.keys(MAX_FIELD_LENGTHS));
    for (const part of parts) {
        if (part.name === 'vehicle_photos[]' && part.filename) {
            if (part.data.length) photos.push(part);
        } else if (!part.filename && allowedFields.has(part.name)) {
            fields[part.name] = part.data.toString('utf8').trim();
        }
    }
    const validationError = validateFields(fields);
    if (validationError) return send(res, 400, validationError);
    if (photos.length > MAX_PHOTOS) return send(res, 400, 'Please attach no more than 5 photos.');

    for (const photo of photos) {
        const extension = path.extname(photo.filename).toLowerCase();
        const type = IMAGE_TYPES[extension];
        if (!type || !type.check(photo.data)) return send(res, 400, 'Use valid JPG, PNG, WEBP, GIF, or HEIC image files.');
    }

    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
    const submissionDir = path.join(UPLOAD_ROOT, id);
    await fs.promises.mkdir(UPLOAD_ROOT, { recursive: true });
    await fs.promises.mkdir(submissionDir, { recursive: false });
    try {
        const savedPhotos = [];
        for (const [index, photo] of photos.entries()) {
            const extension = path.extname(photo.filename).toLowerCase();
            const filename = `vehicle-${index + 1}${extension}`;
            await fs.promises.writeFile(path.join(submissionDir, filename), photo.data, { flag: 'wx' });
            savedPhotos.push({ filename, contentType: IMAGE_TYPES[extension].mime, size: photo.data.length });
        }
        const record = { id, receivedAt: new Date().toISOString(), ...fields, photos: savedPhotos };
        const temporaryRecord = path.join(submissionDir, 'request.json.tmp');
        await fs.promises.writeFile(temporaryRecord, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
        await fs.promises.rename(temporaryRecord, path.join(submissionDir, 'request.json'));
        await emailServiceRequest(record, submissionDir, photos);
        return send(res, 201, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Request received</title><body style="font:16px Arial,sans-serif;max-width:640px;margin:12vh auto;padding:24px;color:#1f2937"><h1>Thank you, ${escapeHtml(fields.name)}.</h1><p>Your service request has been sent to AIM LONG SPARES AND REPAIRS.</p><p><a href="/">Return to the request form</a></p></body></html>`, 'text/html; charset=utf-8');
    } catch (error) {
        if (error.code !== 'EMAIL_DELIVERY_FAILED') await fs.promises.rm(submissionDir, { recursive: true, force: true }).catch(() => {});
        if (error.code === 'EMAIL_DELIVERY_FAILED') {
            console.error('Email delivery failed; request retained locally:', error.cause?.message || error.message);
            return send(res, 503, 'Your request was saved but could not be emailed. Please contact us directly or try again later.');
        }
        throw error;
    }
}

async function emailServiceRequest(record, submissionDir, photos) {
    const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
    const SMTP_PORT = process.env.SMTP_PORT || '465';
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const EMAIL_TO = process.env.EMAIL_TO || 'malcolmmalong@gmail.com';
    const EMAIL_FROM = process.env.EMAIL_FROM;
    if (!SMTP_USER || !SMTP_PASS) {
        const error = new Error('Email delivery is not configured.');
        error.code = 'EMAIL_DELIVERY_FAILED';
        throw error;
    }
    const port = Number(SMTP_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        const error = new Error('SMTP_PORT must be a valid port number.');
        error.code = 'EMAIL_DELIVERY_FAILED';
        throw error;
    }
    const transport = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE === 'true' || port === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    const serviceNames = { repair: 'Repair', maintenance: 'Maintenance', installation: 'Installation', inspection: 'Inspection', other: 'Other' };
    const lines = [
        `Service: ${serviceNames[record.service]}`,
        `Name: ${record.name}`,
        `Phone: ${record.phone}`,
        `Email: ${record.email}`,
        `Location: ${record.location || 'Not provided'}`,
        `Availability: ${record.availability || 'Not provided'}`,
        '', 'Problem description:', record.problem,
        '', `Request ID: ${record.id}`,
    ];
    try {
        await transport.sendMail({
            from: EMAIL_FROM || SMTP_USER,
            to: EMAIL_TO,
            replyTo: record.email,
            subject: `Service request: ${serviceNames[record.service]} — ${record.name}`,
            text: lines.join('\n'),
            attachments: photos.map((photo, index) => ({
                filename: `vehicle-${index + 1}${path.extname(photo.filename).toLowerCase()}`,
                path: path.join(submissionDir, `vehicle-${index + 1}${path.extname(photo.filename).toLowerCase()}`),
                contentType: IMAGE_TYPES[path.extname(photo.filename).toLowerCase()].mime,
            })),
        });
    } catch (cause) {
        const error = new Error('Could not send service request email.', { cause });
        error.code = 'EMAIL_DELIVERY_FAILED';
        throw error;
    }
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/api/service-requests') return await handleSubmission(req, res);
        if (req.method === 'GET' && url.pathname === '/api/service-requests') {
            return send(res, 405, 'Submit requests through the form at /. This endpoint accepts POST submissions only.');
        }
        if (req.method === 'GET' && url.pathname === '/api/health') {
            return send(res, 200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8');
        }
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/SPARE.html')) {
            const page = await fs.promises.readFile(path.join(ROOT, 'SPARE.html'));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
            return res.end(page);
        }
        if (req.method === 'GET' && url.pathname === '/favicon.ico') return send(res, 204, '');
        return send(res, 404, 'Not found.');
    } catch (error) {
        console.error('Request failed:', error);
        if (!res.headersSent) send(res, 500, 'The server could not process this request.');
    }
});

server.listen(PORT, () => console.log(`AIM LONG service form is running at http://localhost:${PORT}`));

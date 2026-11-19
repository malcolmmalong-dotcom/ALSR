'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config();
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const ROOT = __dirname;
const UPLOAD_ROOT = path.join(ROOT, 'submissions');
const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_PHOTOS_BUCKET = process.env.SUPABASE_PHOTOS_BUCKET || 'service-request-photos';
if (Boolean(SUPABASE_URL) !== Boolean(SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error('Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or leave both unset for local file storage.');
}
const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
}) : null;
const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
const MAX_PHOTOS = 5;
const MAX_FIELD_LENGTHS = { name: 120, phone: 40, email: 254, service: 40, location: 200, mileage: 7, problem: 5000, availability: 200 };
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
    if (fields.mileage && (!/^\d{1,7}$/.test(fields.mileage) || Number(fields.mileage) > 9999999)) return 'Please enter a valid vehicle mileage in kilometres.';
    return null;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function safeErrorCode(error) {
    const candidate = error?.safeProviderCode || error?.cause?.code || error?.code || error?.name;
    return typeof candidate === 'string' && /^[a-z0-9_-]{1,40}$/i.test(candidate) ? candidate.toUpperCase() : 'UNKNOWN';
}

function requestStatusPage(title, message, requestId, clearRequestToken = false) {
    const clearTokenScript = clearRequestToken
        ? '<script>try { sessionStorage.removeItem("alsrSubmissionId"); } catch (_) {}</script>'
        : '';
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body style="font:16px Arial,sans-serif;max-width:640px;margin:12vh auto;padding:24px;color:#1f2937">${clearTokenScript}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${requestId ? `<p>Request ID: <code>${escapeHtml(requestId)}</code></p>` : ''}<p><a href="/">Return to the request form</a></p></body></html>`;
}

async function findStoredSubmission(id) {
    if (supabase) {
        const { data, error } = await supabase.from('service_requests')
            .select('id,name,email_status,email_sent_at,email_message_id,email_error_code')
            .eq('id', id)
            .maybeSingle();
        if (error) throw new Error('Could not check request status.');
        return data;
    }
    try {
        return JSON.parse(await fs.promises.readFile(path.join(UPLOAD_ROOT, id, 'request.json'), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function persistEmailStatus(record) {
    const values = {
        email_status: record.emailStatus,
        email_attempted_at: record.emailAttemptedAt || null,
        email_sent_at: record.emailSentAt || null,
        email_message_id: record.emailMessageId || null,
        email_error_code: record.emailErrorCode || null,
    };
    if (supabase) {
        const { error } = await supabase.from('service_requests').update(values).eq('id', record.id);
        if (error) throw new Error('Could not save email status.');
        return;
    }
    const recordPath = path.join(UPLOAD_ROOT, record.id, 'request.json');
    const temporaryPath = `${recordPath}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.promises.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
        await fs.promises.rename(temporaryPath, recordPath);
    } finally {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    }
}

function respondForExistingSubmission(res, record) {
    const status = record.emailStatus || record.email_status || 'pending';
    if (status === 'accepted') {
        return send(res, 201, requestStatusPage(`Thank you, ${record.name}.`, 'Your service request has been sent to AIM LONG SPARES AND REPAIRS.', record.id, true), 'text/html; charset=utf-8');
    }
    if (status === 'failed') {
        return send(res, 503, requestStatusPage('Request saved', 'The mail provider rejected the notification. Your request is saved. Contact ALSR and quote this request ID; please do not submit the same request again.', record.id), 'text/html; charset=utf-8');
    }
    if (status === 'unknown') {
        return send(res, 503, requestStatusPage('Request saved', 'Email delivery could not be confirmed. Your request is saved. Contact ALSR and quote this request ID; please do not submit the same request again.', record.id), 'text/html; charset=utf-8');
    }
    return send(res, 202, requestStatusPage('Request already received', 'This request is already being processed. Please wait or contact ALSR with the request ID; do not submit it again.', record.id), 'text/html; charset=utf-8');
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
    let submissionId = '';
    const allowedFields = new Set(Object.keys(MAX_FIELD_LENGTHS));
    for (const part of parts) {
        if (part.name === 'submission_id' && !part.filename) {
            submissionId = part.data.toString('utf8').trim();
        } else if (part.name === 'vehicle_photos[]' && part.filename) {
            if (part.data.length) photos.push(part);
        } else if (!part.filename && allowedFields.has(part.name)) {
            fields[part.name] = part.data.toString('utf8').trim();
        }
    }
    const validationError = validateFields(fields);
    if (validationError) return send(res, 400, validationError);
    if (photos.length > MAX_PHOTOS) return send(res, 400, 'Please attach no more than 5 photos.');
    if (submissionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) {
        return send(res, 400, 'Invalid submission identifier. Please reload the form and try again.');
    }

    for (const photo of photos) {
        const extension = path.extname(photo.filename).toLowerCase();
        const type = IMAGE_TYPES[extension];
        if (!type || !type.check(photo.data)) return send(res, 400, 'Use valid JPG, PNG, WEBP, GIF, or HEIC image files.');
    }

    const id = submissionId || crypto.randomUUID();
    const existing = await findStoredSubmission(id);
    if (existing) return respondForExistingSubmission(res, existing);
    const submissionDir = path.join(UPLOAD_ROOT, id);
    if (!supabase) {
        await fs.promises.mkdir(UPLOAD_ROOT, { recursive: true });
        try {
            await fs.promises.mkdir(submissionDir, { recursive: false });
        } catch (error) {
            if (error.code === 'EEXIST') {
                const concurrentSubmission = await findStoredSubmission(id);
                if (concurrentSubmission) return respondForExistingSubmission(res, concurrentSubmission);
                return send(res, 202, requestStatusPage('Request already received', 'This request is being saved. Please wait and do not submit it again.', id), 'text/html; charset=utf-8');
            }
            throw error;
        }
    }

    let record;
    try {
        const savedPhotos = [];
        for (const [index, photo] of photos.entries()) {
            const extension = path.extname(photo.filename).toLowerCase();
            const filename = `vehicle-${index + 1}${extension}`;
            const savedPhoto = { filename, contentType: IMAGE_TYPES[extension].mime, size: photo.data.length };
            if (supabase) savedPhoto.storagePath = `${id}/${filename}`;
            else await fs.promises.writeFile(path.join(submissionDir, filename), photo.data, { flag: 'wx' });
            savedPhotos.push(savedPhoto);
        }
        record = {
            id,
            receivedAt: new Date().toISOString(),
            ...fields,
            photos: savedPhotos,
            emailStatus: 'pending',
            emailAttemptedAt: null,
            emailSentAt: null,
            emailMessageId: null,
            emailErrorCode: null,
        };
        if (supabase) await saveSubmissionToSupabase(record, photos);
        else {
            const temporaryRecord = path.join(submissionDir, 'request.json.tmp');
            await fs.promises.writeFile(temporaryRecord, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
            await fs.promises.rename(temporaryRecord, path.join(submissionDir, 'request.json'));
        }
    } catch (error) {
        if (!supabase) await fs.promises.rm(submissionDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }

    record.emailStatus = 'sending';
    record.emailAttemptedAt = new Date().toISOString();
    try {
        await persistEmailStatus(record);
    } catch (error) {
        console.error(`Email status save failed for request ${id}; code=${safeErrorCode(error)}`);
        return send(res, 503, requestStatusPage('Request saved', 'Your request was saved, but the email status could not be recorded, so no email was attempted. Contact ALSR and quote this request ID; please do not submit it again.', id), 'text/html; charset=utf-8');
    }

    let mailInfo;
    try {
        mailInfo = await emailServiceRequest(record, photos);
    } catch (error) {
        record.emailStatus = error.deliveryStatus || 'unknown';
        record.emailErrorCode = error.safeProviderCode || safeErrorCode(error);
        try {
            await persistEmailStatus(record);
        } catch (statusError) {
            console.error(`Email status save failed for request ${id}; code=${safeErrorCode(statusError)}`);
        }
        console.error(`Email delivery ${record.emailStatus} for request ${id}; code=${record.emailErrorCode}`);
        const message = record.emailStatus === 'failed'
            ? 'Your request was saved, but the mail provider rejected the notification. Contact ALSR and quote this request ID; please do not submit it again.'
            : 'Your request was saved, but email delivery could not be confirmed. Contact ALSR and quote this request ID; please do not submit it again.';
        return send(res, 503, requestStatusPage('Request saved', message, id), 'text/html; charset=utf-8');
    }

    record.emailStatus = 'accepted';
    record.emailSentAt = new Date().toISOString();
    record.emailMessageId = mailInfo.messageId || null;
    try {
        await persistEmailStatus(record);
    } catch (error) {
        console.error(`Email was accepted but status save failed for request ${id}; code=${safeErrorCode(error)}`);
    }
    return send(res, 201, requestStatusPage(`Thank you, ${fields.name}.`, 'Your service request has been sent to AIM LONG SPARES AND REPAIRS.', id, true), 'text/html; charset=utf-8');
}

async function saveSubmissionToSupabase(record, photos) {
    const uploadedPaths = [];
    try {
        for (const [index, photo] of photos.entries()) {
            const extension = path.extname(photo.filename).toLowerCase();
            const storagePath = `${record.id}/vehicle-${index + 1}${extension}`;
            const { error } = await supabase.storage.from(SUPABASE_PHOTOS_BUCKET).upload(storagePath, photo.data, {
                contentType: IMAGE_TYPES[extension].mime,
                upsert: false,
            });
            if (error) throw error;
            uploadedPaths.push(storagePath);
        }
        const { error } = await supabase.from('service_requests').insert({
            id: record.id,
            received_at: record.receivedAt,
            name: record.name,
            phone: record.phone,
            email: record.email,
            service: record.service,
            location: record.location || null,
            mileage: record.mileage ? Number(record.mileage) : null,
            problem: record.problem,
            availability: record.availability || null,
            photos: record.photos,
            email_status: record.emailStatus,
            email_attempted_at: record.emailAttemptedAt,
            email_sent_at: record.emailSentAt,
            email_message_id: record.emailMessageId,
            email_error_code: record.emailErrorCode,
        });
        if (error) throw error;
    } catch (error) {
        if (uploadedPaths.length) await supabase.storage.from(SUPABASE_PHOTOS_BUCKET).remove(uploadedPaths).catch(() => {});
        throw error;
    }
}

async function emailServiceRequest(record, photos) {
    const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
    const SMTP_PORT = process.env.SMTP_PORT || '465';
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const EMAIL_TO = process.env.EMAIL_TO || 'malcolmmalong@gmail.com';
    const EMAIL_FROM = process.env.EMAIL_FROM;
    if (!SMTP_USER || !SMTP_PASS) {
        const error = new Error('Email delivery is not configured.');
        error.code = 'EMAIL_DELIVERY_FAILED';
        error.deliveryStatus = 'failed';
        error.safeProviderCode = 'SMTP_NOT_CONFIGURED';
        throw error;
    }
    const port = Number(SMTP_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        const error = new Error('SMTP_PORT must be a valid port number.');
        error.code = 'EMAIL_DELIVERY_FAILED';
        error.deliveryStatus = 'failed';
        error.safeProviderCode = 'INVALID_SMTP_PORT';
        throw error;
    }
    const configuredSecure = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
    const secure = configuredSecure === 'true' ? true : configuredSecure === 'false' ? false : port === 465;
    const transport = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    const serviceNames = { repair: 'Repair', maintenance: 'Maintenance', installation: 'Installation', inspection: 'Inspection', other: 'Other' };
    const lines = [
        `Service: ${serviceNames[record.service]}`,
        `Name: ${record.name}`,
        `Phone: ${record.phone}`,
        `Email: ${record.email}`,
        `Location: ${record.location || 'Not provided'}`,
        `Vehicle mileage: ${record.mileage ? `${record.mileage} km` : 'Not provided'}`,
        `Availability: ${record.availability || 'Not provided'}`,
        '', 'Problem description:', record.problem,
        '', `Request ID: ${record.id}`,
    ];
    try {
        const result = await transport.sendMail({
            from: EMAIL_FROM || SMTP_USER,
            to: EMAIL_TO,
            replyTo: record.email,
            subject: `Service request: ${serviceNames[record.service]} — ${record.name}`,
            text: lines.join('\n'),
            attachments: photos.map((photo, index) => ({
                filename: `vehicle-${index + 1}${path.extname(photo.filename).toLowerCase()}`,
                content: photo.data,
                contentType: IMAGE_TYPES[path.extname(photo.filename).toLowerCase()].mime,
            })),
        });
        if (!result.accepted?.length) {
            const error = new Error('The SMTP server did not accept the recipient.');
            error.code = 'EMAIL_DELIVERY_FAILED';
            error.deliveryStatus = 'failed';
            error.safeProviderCode = 'SMTP_RECIPIENT_REJECTED';
            throw error;
        }
        return { messageId: result.messageId };
    } catch (cause) {
        if (cause.code === 'EMAIL_DELIVERY_FAILED') throw cause;
        const code = safeErrorCode(cause);
        const responseCode = Number(cause.responseCode);
        const definitelyRejected = (Number.isInteger(responseCode) && responseCode >= 400) || ['EAUTH', 'EENVELOPE'].includes(code);
        const error = new Error('Could not send service request email.');
        error.code = 'EMAIL_DELIVERY_FAILED';
        error.deliveryStatus = definitelyRejected ? 'failed' : 'unknown';
        error.safeProviderCode = code;
        throw error;
    } finally {
        transport.close();
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
        console.error(`Request failed; code=${safeErrorCode(error)}`);
        if (!res.headersSent) send(res, 500, 'The server could not process this request.');
    }
});

const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
server.listen(PORT, HOST, () => console.log('AIM LONG service form is running on http://' + HOST + ':' + PORT + (supabase ? ' with Supabase storage' : '')));

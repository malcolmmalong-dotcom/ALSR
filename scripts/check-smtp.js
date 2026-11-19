#!/usr/bin/env node
'use strict';

require('dotenv').config();
const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST || 'smtp.gmail.com';
const port = Number(process.env.SMTP_PORT || 465);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const configuredSecure = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
const secure = configuredSecure === 'true' ? true : configuredSecure === 'false' ? false : port === 465;

function safeCode(error) {
    const code = error?.code || error?.name || 'UNKNOWN';
    return typeof code === 'string' && /^[a-z0-9_-]{1,40}$/i.test(code) ? code.toUpperCase() : 'UNKNOWN';
}

if (!user || !pass) {
    console.error('SMTP check failed: SMTP_USER and SMTP_PASS must both be set. Values were not displayed.');
    process.exitCode = 1;
} else if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('SMTP check failed: SMTP_PORT must be a valid port number.');
    process.exitCode = 1;
} else {
    const transport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    transport.verify().then(() => {
        console.log('SMTP connection and authentication succeeded. No email was sent. This does not confirm inbox delivery.');
    }).catch(error => {
        const responseCode = Number(error?.responseCode);
        console.error(`SMTP check failed; code=${safeCode(error)}${Number.isInteger(responseCode) ? `; response=${responseCode}` : ''}. No email was sent; secret values were not displayed.`);
        process.exitCode = 1;
    }).finally(() => transport.close());
}

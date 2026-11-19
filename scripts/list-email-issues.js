#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UPLOAD_ROOT = path.join(__dirname, '..', 'submissions');

function safeCode(value) {
    return typeof value === 'string' && /^[a-z0-9_-]{1,40}$/i.test(value) ? value.toUpperCase() : '-';
}

async function listLocalIssues() {
    const entries = await fs.readdir(UPLOAD_ROOT, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const issues = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
            const record = JSON.parse(await fs.readFile(path.join(UPLOAD_ROOT, entry.name, 'request.json'), 'utf8'));
            const status = record.emailStatus || 'legacy';
            if (status !== 'accepted') issues.push({ id: record.id || entry.name, status, receivedAt: record.receivedAt || '-', code: record.emailErrorCode });
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
            issues.push({ id: entry.name, status: 'incomplete', receivedAt: '-', code: '-' });
        }
    }
    return issues;
}

async function listSupabaseIssues() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_CONFIGURATION');
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await supabase.from('service_requests')
        .select('id,received_at,email_status,email_error_code')
        .neq('email_status', 'accepted')
        .order('received_at', { ascending: true });
    if (error) throw new Error('SUPABASE_QUERY_FAILED');
    return (data || []).map(row => ({
        id: row.id,
        status: row.email_status || 'legacy',
        receivedAt: row.received_at || '-',
        code: row.email_error_code,
    }));
}

(async () => {
    try {
        if (Boolean(SUPABASE_URL) !== Boolean(SUPABASE_SERVICE_ROLE_KEY)) throw new Error('SUPABASE_CONFIGURATION');
        const issues = SUPABASE_URL ? await listSupabaseIssues() : await listLocalIssues();
        if (!issues.length) {
            console.log('No saved requests need email review. No email was sent.');
            return;
        }
        console.log('Saved requests requiring review (no contact details displayed; no email was sent):');
        for (const item of issues) console.log(`${item.id}  status=${item.status}  code=${safeCode(item.code)}  received=${item.receivedAt}`);
    } catch (error) {
        const code = error.message === 'SUPABASE_CONFIGURATION' ? 'SUPABASE_CONFIGURATION' : error.message === 'SUPABASE_QUERY_FAILED' ? 'SUPABASE_QUERY_FAILED' : 'LOCAL_READ_FAILED';
        console.error(`Could not list saved requests; code=${code}. Secret values and request details were not displayed.`);
        process.exitCode = 1;
    }
})();

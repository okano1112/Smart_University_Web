'use strict';
require('dotenv').config({ path: require('node:path').join(__dirname, '../database.env'), quiet: true });
require('dotenv').config({ quiet: true });

const { randomUUID } = require('node:crypto');
const { access, mkdir, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline/promises');
const { Writable } = require('node:stream');
const { ACCOUNT_FILE, MIN_PASSWORD_LENGTH, makeLoginAccount } = require('../room-login');
const { createAuthStore } = require('../auth-store');

async function setup() {
    const args = process.argv.slice(2);
    const reset = args.length === 1 && args[0] === '--reset';
    if (args.length && !reset) throw new Error('ใช้ npm run auth:setup หรือ npm run auth:setup -- --reset');
    const file = path.resolve(process.env.BIMCLUB_LOGIN_ACCOUNT_FILE || ACCOUNT_FILE);
    const store = createAuthStore({ accountFile: process.env.BIMCLUB_LOGIN_ACCOUNT_FILE });
    try {
        if (store.storage === 'fixed') {
            if (reset) throw new Error('โหมด fixed ใช้บัญชีที่เตรียมไว้แล้ว การเปลี่ยนบัญชีต้องเลือกโหมด file หรือ postgres ก่อน');
            console.log('บัญชี adminbim พร้อมใช้งานแล้ว เปิดเว็บและเข้าสู่ระบบได้ทันที');
            return;
        }
        if (store.database) {
            const existing = await store.getAccount();
            if (existing && !reset) {
                console.log('ฐานข้อมูลกลางมีบัญชีแล้ว ใช้บัญชีเดิมบน Mac และ Windows ได้เลย');
                return;
            }
        }
        if (!reset) {
            const exists = !store.database && await access(file).then(() => true, error => {
                if (error.code === 'ENOENT') return false;
                throw error;
            });
            if (exists) throw new Error('ตั้งบัญชีไว้แล้ว หากต้องการเปลี่ยนให้ใช้ npm run auth:setup -- --reset');
        }
        if (!process.stdin.isTTY) throw new Error('กรุณารันคำสั่งนี้ใน Terminal เพื่อพิมพ์รหัสผ่านโดยไม่แสดงบนจอ');

        let hidden = false;
        const mutedOutput = new Writable({
            write(chunk, _encoding, callback) {
                if (!hidden) process.stdout.write(chunk);
                callback();
            }
        });
        const reader = createInterface({ input: process.stdin, output: mutedOutput, terminal: true, historySize: 0 });
        const stopped = new AbortController();
        reader.on('SIGINT', () => stopped.abort());
        const ask = prompt => reader.question(prompt, { signal: stopped.signal });
        async function secret(prompt) {
            process.stdout.write(prompt);
            hidden = true;
            try { return await ask(''); }
            finally { hidden = false; process.stdout.write('\n'); }
        }
        let account;
        try {
            const username = (await ask('ชื่อผู้ใช้ [admin]: ')).trim() || 'admin';
            const password = await secret(`รหัสผ่านใหม่ (อย่างน้อย ${MIN_PASSWORD_LENGTH} ตัว): `);
            if (password !== await secret('พิมพ์รหัสผ่านอีกครั้ง: ')) throw new Error('รหัสผ่านทั้งสองครั้งไม่ตรงกัน');
            account = await makeLoginAccount(username, password);
        } finally { reader.close(); }

        if (store.database) await store.saveAccount(account, reset);
        else {
            await mkdir(path.dirname(file), { recursive: true });
            const contents = JSON.stringify(account, null, 2) + '\n';
            if (!reset) await writeFile(file, contents, { flag: 'wx', mode: 0o600 });
            else {
                const temporary = file + '.' + randomUUID() + '.tmp';
                try {
                    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
                    await rename(temporary, file);
                } finally { await rm(temporary, { force: true }); }
            }
        }
        console.log(store.database ? 'บันทึกบัญชีกลางแล้ว ใช้บัญชีเดียวกันบน Mac และ Windows ได้' :
            reset ? 'บันทึกบัญชีแล้ว กรุณาเริ่มเว็บใหม่เพื่อยกเลิกเซสชันเดิม' : 'ตั้งบัญชีแล้ว เปิดหน้า /login เพื่อเข้าสู่ระบบ');
    } finally { await store.close(); }
}

setup().catch(error => {
    if (error.name === 'AbortError') { console.error('ยกเลิกการตั้งบัญชี'); process.exitCode = 130; return; }
    console.error(['ACCOUNT_EXISTS', 'AUTH_DATABASE_UNAVAILABLE'].includes(error.code) ? error.message :
        error.code ? 'บันทึกบัญชีไม่ได้ กรุณาตรวจสิทธิ์ของโฟลเดอร์ data' : error.message);
    process.exitCode = 1;
});

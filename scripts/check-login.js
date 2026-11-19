'use strict';
require('dotenv').config({ path: require('node:path').join(__dirname, '../database.env'), quiet: true });
require('dotenv').config({ quiet: true });
const { createAuthStore } = require('../auth-store');

async function main() {
    const store = createAuthStore({ accountFile: process.env.BIMCLUB_LOGIN_ACCOUNT_FILE });
    try {
        if (process.argv.includes('--require-database') && !store.database) {
            console.error('เลือก BIMCLUB_AUTH_MODE=postgres และตั้ง DATABASE_URL ใน database.env เพื่อใช้ฐานข้อมูลกลาง');
            process.exitCode = 2;
            return;
        }
        const account = await store.getAccount();
        console.log(JSON.stringify({ storage: store.storage, accountReady: !!account }));
        if (!account) process.exitCode = 1;
    } catch (_) {
        console.error('ติดต่อ PostgreSQL กลางไม่ได้ กรุณาตรวจ DATABASE_URL และอินเทอร์เน็ต');
        process.exitCode = 3;
    } finally { await store.close(); }
}

main().catch(() => {
    console.error('DATABASE_URL ไม่ถูกต้อง กรุณาตรวจค่าจากผู้ให้บริการ PostgreSQL');
    process.exitCode = 3;
});

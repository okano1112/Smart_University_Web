# ฐานข้อมูลบัญชีแบบเลือกใช้

ปัจจุบันเว็บใช้โหมด `fixed` พร้อมบัญชีผู้ดูแลที่กำหนดไว้ในโปรเจกต์ เปิดบน Mac และ Windows ด้วยบัญชีเดียวกันได้ทันทีตาม [คู่มือเข้าสู่ระบบ](LOGIN.md) การเปิดเว็บในโหมดนี้ไม่ต้องตั้ง `database.env` หรือสมัครฐานข้อมูลออนไลน์

ส่วน PostgreSQL ที่เตรียมไว้เป็นทางเลือกสำหรับระบบบัญชีกลางในอนาคต เก็บเฉพาะบัญชีผู้ดูแลและเซสชันเข้าเว็บ การเปิดใช้ส่วนนี้ไม่ได้ย้ายข้อมูลอุณหภูมิ ตารางเวลา Logs หรือ Flow ของ Node-RED ไปเป็นฐานข้อมูลร่วมกัน

## เปิดใช้ PostgreSQL ในอนาคต

1. สร้าง PostgreSQL ออนไลน์ เช่น [Neon](https://neon.com/) แล้วคัดลอก Connection string จากผู้ให้บริการ
2. คัดลอก `database.env.example` เป็น `database.env` ในโฟลเดอร์โปรเจกต์ ใส่ค่าเชื่อมต่อและเลือกโหมดให้ชัดเจน

```dotenv
BIMCLUB_AUTH_MODE=postgres
DATABASE_URL='postgresql://USERNAME:PASSWORD@HOST:5432/DATABASE?sslmode=require'
```

ไฟล์นี้อยู่นอก Git และ Docker image หากใช้บน Mac และ Windows ให้ทั้งสองเครื่องชี้ Project, branch และ database เดียวกัน ฐานข้อมูลออนไลน์จึงยังใช้งานได้เมื่อ Windows ปิดอยู่

3. บน Mac ตรวจการเชื่อมต่อและตั้งบัญชีกลางครั้งแรก

```sh
npm run db:check
npm run auth:setup
npm start
```

ถ้ามีบัญชีกลางอยู่แล้วให้ใช้บัญชีนั้น หากฐานข้อมูลยังว่างและมี `data/login-account.json` จากรุ่นเดิม ระบบนำเข้าแฮชบัญชีเดิมให้ การเลือกโหมด `postgres` ใช้บัญชีในฐานข้อมูลแทนบัญชีที่ติดกับโหมด `fixed`

4. สำหรับ Docker ให้แก้ `BIMCLUB_AUTH_MODE: fixed` ใน `compose.yaml` เป็น `BIMCLUB_AUTH_MODE: postgres` วาง `database.env` ข้าง `Start-BimClub.cmd` และรันตัวเริ่มระบบอีกครั้ง ถ้าฐานข้อมูลยังไม่มีบัญชี ให้ตั้งบัญชีด้วยคำสั่งนี้ก่อนรันตัวเริ่มระบบซ้ำ

```powershell
docker compose exec web node scripts/setup-login.js
```

## พฤติกรรมในโหมด PostgreSQL

บัญชีและเซสชันอยู่ใน schema `bimclub_auth` เซสชันใช้ต่อได้หลังเว็บรีสตาร์ต การเปลี่ยนบัญชีกลางด้วย `npm run auth:setup -- --reset` ยกเลิกเซสชันทุกเครื่อง การออกจากระบบยกเลิกเฉพาะเซสชันของเบราว์เซอร์นั้น

เมื่อฐานข้อมูลติดต่อไม่ได้ เว็บตอบ HTTP 503 ให้แก้การเชื่อมต่อแล้วใช้บัญชีเดิมต่อ การเข้าผ่าน Cloudflare ยังขึ้นกับการทำงานของเว็บบน Windows

หากต้องการกลับมาใช้บัญชีที่ติดกับโปรเจกต์ ให้เลือก `BIMCLUB_AUTH_MODE=fixed` บน Node.js หรือ `BIMCLUB_AUTH_MODE: fixed` ใน Compose แล้วรีสตาร์ตเว็บ

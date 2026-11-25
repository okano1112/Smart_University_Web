# เปิดเว็บ BimClub ผ่าน Cloudflare Worker

ใช้ URL ฟรีรูปแบบ `https://bimclub-room.<workers-subdomain>.workers.dev` เบราว์เซอร์เข้าที่ Worker แล้ว Worker ส่งคำขอผ่าน VPC Service และ Cloudflare Tunnel ไปที่ `http://127.0.0.1:3000` บน Windows เครื่องเดียวกับที่รันเว็บและโมเดล Engi [คู่มือ workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) · [คู่มือ Workers VPC](https://developers.cloudflare.com/workers-vpc/get-started/)

ตราบใดที่ใช้ชื่อ Worker และ Workers subdomain เดิม URL จะคงที่เมื่อรีสตาร์ตหรือลง Windows ใหม่ ระหว่างที่แอปหรือ Tunnel หยุดทำงาน Worker จะแจ้งว่าเซิร์ฟเวอร์ไม่พร้อม และเว็บจะเข้าได้อีกครั้งเมื่อทั้งสองส่วนกลับมาทำงาน

## ตั้งค่าครั้งแรก

1. เปิดเว็บบน Windows ให้ `http://127.0.0.1:3000/login` ใช้งานได้ก่อน ดาวน์โหลดโมเดลและตั้งบัญชี BimClub ตาม [คู่มือ Windows](../offline-voice/README.md#ติดตั้ง-engi-บน-windows) ถ้าใช้พอร์ตอื่น ให้ใช้พอร์ตจริงใน VPC Service ด้วย
2. ใน Cloudflare dashboard ไปที่ **Workers VPC → Tunnels → Create** ตั้งชื่อ Tunnel เช่น `bimclub-windows` เลือก **Windows** แล้วทำตามคำสั่งติดตั้ง `cloudflared` และ `cloudflared.exe service install <TUNNEL_TOKEN>` ที่ dashboard ให้ไว้ใน PowerShell ที่เปิดแบบผู้ดูแล เมื่อเสร็จแล้วให้ตรวจว่า Tunnel ขึ้น **Connected** หรือ **Healthy** เก็บ Tunnel token ไว้ใน Cloudflare หรือที่เก็บรหัสผ่านของคุณ [คู่มือตั้ง Tunnel บน Windows](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/#4-install-and-run-the-tunnel)
3. ไปที่ **Workers VPC → VPC Services → Create** เลือก Tunnel ข้างต้น ตั้งชื่อ Service เช่น `bimclub-origin` ใส่ Host/IP เป็น `127.0.0.1` และตั้ง **HTTP port** เป็น `3000` ใช้ Tunnel เป็น DNS resolver แล้วคัดลอก **Service ID** ที่สร้างได้ [คู่มือสร้าง VPC Service](https://developers.cloudflare.com/workers-vpc/get-started/#3-create-a-vpc-service)
4. เปิด [`wrangler.jsonc`](wrangler.jsonc) เปลี่ยน `REPLACE_WITH_VPC_SERVICE_ID` เป็น Service ID จากข้อ 3 ชื่อ binding ในไฟล์คือ `BIMCLUB_ORIGIN` จากนั้นเปิด PowerShell ที่โฟลเดอร์โปรเจกต์ แล้วรัน

   ```powershell
   npx.cmd --yes wrangler@4 login
   npx.cmd --yes wrangler@4 deploy --config .\cloudflare\wrangler.jsonc
   ```

   ครั้งแรก ให้สมัคร Workers subdomain ฟรีใน Cloudflare dashboard หากบัญชียังไม่มี เลือกบัญชีเดียวกับที่สร้าง Tunnel และ Service แล้วเปิด URL ที่ `wrangler deploy` แสดง [คำสั่ง Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/) · [การตั้ง workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

5. เข้าสู่ระบบ BimClub ที่ URL นั้น อนุญาตไมโครโฟนสำหรับ URL ใหม่ แล้วเรียก “เอ็นจี้” หากหน้า Login เปิดได้แต่ Engi ยังไม่พร้อม ให้ตรวจว่า PowerShell ฝั่ง Windows ขึ้น `Local Whisper พร้อมรับคำสั่ง`

Workers VPC ยังอยู่ในช่วง Beta และต้องใช้ `cloudflared` 2025.7.0 ขึ้นไปกับ QUIC ผ่าน UDP ขาออกพอร์ต 7844 [ข้อกำหนด Tunnel สำหรับ Workers VPC](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/#create-and-run-tunnel-cloudflared)

## เปิดภาพสดเมื่อรันเว็บบน Windows โดยตรง

ให้เปิด MediaMTX บนเครื่อง Windows เครื่องเดียวกับเว็บเพื่อแปลงสตรีม RTSP เป็น HLS ตรวจว่าเครื่องนี้เข้าถึงกล้องได้ แล้วคัดลอก `camera.env.example` เป็น `camera.env` และใส่ URL กล้องตามคู่มือ คำสั่งด้านล่างใช้ไฟล์ `camera/mediamtx.yml` และเปิด HLS เฉพาะที่ `127.0.0.1:8888` เพื่อให้เว็บส่งภาพต่อหลังเข้าสู่ระบบ [คู่มือกล้อง RTSP](../CAMERA.md) · [ดาวน์โหลด MediaMTX v1.21.4 สำหรับ Windows](https://github.com/bluenviron/mediamtx/releases/tag/v1.21.4)

```powershell
npm.cmd run camera:start -- "C:\MediaMTX\mediamtx.exe"
```

ถ้าเพิ่ม `mediamtx.exe` ใน `PATH` แล้ว ใช้ `npm.cmd run camera:start` ได้ ปล่อยให้ MediaMTX รันคู่กับ `npm.cmd start` แล้วเข้าหน้าแดชบอร์ดผ่าน Worker และกด **เปิดภาพสด** หากรันเว็บผ่าน Docker ให้ใช้โปรไฟล์ `camera` ของ Docker [คู่มือกล้อง RTSP](../CAMERA.md)

ถ้าต้องการให้ภาพสดกลับมาเองหลังรีสตาร์ต ให้สร้างงาน **At startup** เพิ่มใน Task Scheduler ใช้ `node.exe` ใน **Program/script** ใส่ `scripts\start-camera.js "C:\MediaMTX\mediamtx.exe"` ใน **Add arguments** และใส่โฟลเดอร์โปรเจกต์ใน **Start in** ใช้บัญชีที่อ่าน `camera.env` ได้และตั้งให้งานรันได้ต่อเนื่องเหมือนงานเปิดเว็บ [คู่มือ Task Scheduler](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-page)

## เปิดกลับหลังรีสตาร์ตหรือลง Windows ใหม่

- หลังรีสตาร์ต ตรวจ `Get-Service cloudflared` ใน PowerShell แล้วเปิดเว็บด้วย `npm.cmd start` ในโฟลเดอร์โปรเจกต์ หากต้องการให้เว็บเริ่มตอนเปิดเครื่อง ให้สร้างงานใน **Task Scheduler** แบบ **At startup** ใช้บัญชี Windows เดียวกับที่ติดตั้ง Engi เลือกให้รันได้แม้ยังไม่ได้ลงชื่อเข้าใช้ ตั้ง **Program/script** เป็นพาธเต็มของ `node.exe` ตั้ง **Add arguments** เป็น `server.js` และ **Start in** เป็นพาธโฟลเดอร์โปรเจกต์ ในแท็บ **Settings** เอาเครื่องหมายถูกหน้า **Stop the task if it runs longer than** ออกเพื่อให้เว็บเปิดต่อเนื่อง [คู่มือ Task Scheduler](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page) · [เวลารันของงาน](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit)
- หลังล้างเครื่อง ให้ติดตั้งเว็บและ Engi ใหม่ตาม [คู่มือ Windows](../offline-voice/README.md#ติดตั้ง-engi-บน-windows) บัญชีผู้ดูแลมากับโปรเจกต์แล้ว กู้ `data/ac-schedules.json` จากสำรองหากมี แล้วติดตั้ง `cloudflared` ด้วย token ของ Tunnel เดิมจาก dashboard URL เดิมจะกลับมาใช้ได้เมื่อ Tunnel และแอปพร้อม

ถ้า URL เปิดได้แต่ Worker ตอบ `503` ให้ตรวจหน้า Login ที่ localhost ก่อน จากนั้นตรวจสถานะ Tunnel และค่า Host/IP กับ HTTP port ของ VPC Service หากเปลี่ยน Service ให้แก้ Service ID แล้ว deploy ด้วยชื่อ Worker เดิม

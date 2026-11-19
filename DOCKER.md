# BimClub Docker

ชุดนี้รันเว็บ Engi และ Node-RED บน Docker Desktop แบบ Linux/amd64 สำหรับ Windows x64 น้ำหนัก Whisper และโมเดล Client อยู่ใน image แล้ว

## เปิดบน Windows

1. ติดตั้ง [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) เปิด WSL 2 และเริ่ม Docker Desktop ด้วย Linux containers
2. แตก ZIP `bimclub-docker-ready-login-windows-amd64.zip` ลงโฟลเดอร์บนเครื่องเซิร์ฟเวอร์ หยุดเว็บ Node.js และ Node-RED ตัวเดิมที่ใช้พอร์ต 3000 และ 1880
3. ดับเบิลคลิก `Start-BimClub.cmd` ระบบตรวจ checksum โหลด image และเปิดทั้งสองบริการ บัญชี `adminbim` พร้อมรหัสที่กำหนดไว้ใช้งานได้ทันที
4. เข้าเว็บที่ `http://127.0.0.1:3000/` และ Node-RED editor ที่ `http://127.0.0.1:1880/`

ชุดนี้ใช้โหมดบัญชี `fixed` ไม่ต้องสร้างบัญชีหรือตั้งฐานข้อมูลออนไลน์ ดูรายละเอียดได้ใน [คู่มือเข้าสู่ระบบ](LOGIN.md)

ใช้ PowerShell ได้ด้วย

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-BimClub.ps1
```

Container ตั้งให้กลับมาทำงานเมื่อ Docker Desktop เริ่ม เปิดตัวเลือกให้ Docker Desktop เริ่มพร้อม Windows ตามการใช้งานของเครื่อง

## ย้ายข้อมูลเดิม

ก่อนเปิดครั้งแรก ระบุโฟลเดอร์โปรเจกต์เดิมบน Windows เพื่อใช้ตารางเวลาและ Flow เดิม

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-BimClub.ps1 -ImportFrom "C:\Smart_University_Web"
```

ตัวนำเข้าคัดลอกเฉพาะ `data/login-account.json`, `data/ac-schedules.json`, `node-red/runtime/flows.json`, `flows_cred.json` และ `.config.runtime.json` ไปยังโฟลเดอร์ `seed/` เมื่อ Docker volume มีข้อมูลแล้ว ข้อมูลใน volume จะถูกใช้ต่อ ไฟล์บัญชีเดิมที่นำเข้าจะไม่เปลี่ยนบัญชีที่กำหนดไว้ในโหมด `fixed`

หาก Node-RED เดิมใช้ user directory อื่น ให้นำ `flows.json`, `flows_cred.json` และ `.config.runtime.json` จาก directory นั้นมาวางใน `seed/node-red/` ก่อนเริ่มครั้งแรก

บัญชีที่กำหนดไว้มากับ image ส่วนเซสชันเก็บในหน่วยความจำและต้องเข้าสู่ระบบใหม่หลังรีสตาร์ตเว็บ ไฟล์นำเข้า ตารางเวลา และ Flow ที่แก้ใน editor เก็บใน named volumes `bimclub_web_data` และ `bimclub_node_red_data` เก็บสำรอง volumes นี้ก่อนย้ายเครื่องหรือล้าง Docker Desktop

หากต้องการเลือกใช้ PostgreSQL กลางในอนาคต ดู [คู่มือฐานข้อมูล](DATABASE.md)

## Cloudflare และ CiRA

Windows Cloudflare service เดิมเชื่อมที่ `127.0.0.1:3000` ได้ต่อ ใช้ Worker, Tunnel และ URL เดิม อินเทอร์เน็ตยังต้องพร้อมสำหรับ Cloudflare และ MQTT ที่ `broker.emqx.io`

CiRA CORE ส่งจำนวนคนที่ MQTT `broker.emqx.io:1883` Topic `spu/classroom/room/person` และ payload `{"total_people":2}` ตามเดิม Node-RED จะส่งต่อไป `spu/classroom/cira`

ถ้าเพิ่ม Skeleton ภายหลัง ให้ CiRA บน Windows ส่งเฟรมไป `http://127.0.0.1:1880/cira-pose-frame` ตาม [รูปแบบ Pose ของโปรเจกต์](CIRA_ACTIVITY.md) ตัว CiRA CORE และ ESP32 ทำงานบนอุปกรณ์ของตน ส่วน Docker ชุดนี้รับผลเข้า Node-RED และเว็บ

พอร์ตเว็บและ editor ผูกที่ loopback ของ Windows การเข้าเว็บจากภายนอกใช้ Cloudflare HTTPS

## ตรวจสถานะ

```powershell
docker compose ps
docker compose logs --tail 100 web node-red
Invoke-RestMethod http://127.0.0.1:1880/cira-observability
Invoke-RestMethod http://127.0.0.1:1880/cira-activity
```

ค่าที่ควรเห็นคือบริการทั้งคู่เป็น `healthy` จุดอ่าน Node-RED คืน `source: cira` หลังล็อกอิน หน้า Logs ของเว็บจะอ่านสถานะจาก Node-RED ได้ หากกล้องยังไม่มีข้อมูล รายการกิจกรรมจะอยู่ในสถานะรอข้อมูล

## อัปเดต

แตก ZIP รุ่นใหม่ลงโฟลเดอร์เดิม แล้วรัน `Start-BimClub.cmd` อีกครั้ง ตัวเริ่มระบบโหลด image ใหม่และสร้าง container ทั้งคู่พร้อมกัน โดยใช้ named volumes เดิม

```powershell
docker compose stop
docker compose start
```

สองคำสั่งข้างต้นใช้หยุดและเปิดชุดเดิม

## สร้างแพ็กเกจจากโปรเจกต์บน Mac

```sh
python3 scripts/package-docker.py
```

สคริปต์ build image แบบ Linux/amd64 บันทึก image ทั้งสองเป็น tar แล้วรวมเป็น ZIP ที่ `dist/bimclub-docker-ready-login-windows-amd64.zip` พร้อม SHA-256 การ build ครั้งแรกดาวน์โหลด base image และ Python/npm packages หากมีน้ำหนักเสียงที่ครบอยู่ในโปรเจกต์ จะนำมาใช้ใน image

ใช้ `--no-build` เพื่อ export image ที่ build และทดสอบแล้ว หรือ `--include-data` เพื่อใส่ข้อมูลส่วนตัวของเครื่องที่แพ็กลงใน `seed/` ด้วย แพ็กเกจปกติใช้บัญชีที่กำหนดไว้ใน image ได้ทันที

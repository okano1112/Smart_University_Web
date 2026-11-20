# BimClub Docker

ชุดนี้รันเว็บ Engi, ระบบควบคุมแอร์ตามจำนวนคน และ Node-RED ด้วยอิมเมจ Linux/amd64 ใช้ได้กับเซิร์ฟเวอร์ Linux x64 ที่มี Docker Engine และ Compose v2 หรือ Windows x64 ที่เปิด Docker Desktop ในโหมด Linux containers โมเดลเสียงอยู่ในอิมเมจเว็บหลัง build เสร็จ

## รันบนเซิร์ฟเวอร์จากซอร์ส

คัดลอกโฟลเดอร์โปรเจกต์รุ่นนี้ไปไว้บนเครื่องเซิร์ฟเวอร์ เปิดเทอร์มินัลในโฟลเดอร์ที่มี `compose.yaml` และตรวจว่าพอร์ต `3000` กับ `1880` บนเครื่องว่าง การ build ครั้งแรกต้องใช้อินเทอร์เน็ตสำหรับอิมเมจพื้นฐาน แพ็กเกจ และโมเดลเสียง

```sh
docker compose config --quiet
docker compose build
```

เมื่อ build สำเร็จ ให้เปิดบริการทั้งสองแล้วตรวจสถานะ [ตัวเลือก `docker compose up`](https://docs.docker.com/reference/cli/docker/compose/up/)

```sh
docker compose up -d --no-build --pull never --wait --wait-timeout 180
docker compose ps
```

บนเครื่องเซิร์ฟเวอร์ เปิดเว็บที่ `http://127.0.0.1:3000/` และ Node-RED ที่ `http://127.0.0.1:1880/` ดูรายละเอียดบัญชีใน [คู่มือเข้าสู่ระบบ](LOGIN.md)

หากต้องการดูภาพกล้องในแดชบอร์ด ให้เปิดโปรไฟล์ `camera` ตาม [คู่มือต่อกล้อง RTSP](CAMERA.md)

### เข้าเว็บจากอีกเครื่อง

ใช้ URL ของ Cloudflare Tunnel เดิม หากใช้ SSH ให้รันคำสั่งนี้จากเครื่องที่จะเปิดเว็บ โดยแทน `USER` และ `SERVER_IP` ด้วยข้อมูลของเซิร์ฟเวอร์ พอร์ตฝั่งผู้ใช้ใช้ `13000` และ `11880` เพื่อแยกจากบริการที่อาจเปิดอยู่บนเครื่องนั้น

```sh
ssh -N -L 13000:127.0.0.1:3000 -L 11880:127.0.0.1:1880 USER@SERVER_IP
```

เปิดเว็บที่ `http://127.0.0.1:13000/` และ Node-RED editor ที่ `http://127.0.0.1:11880/` ระหว่างที่ SSH ยังทำงาน

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

ก่อนเปิดครั้งแรก ระบุโฟลเดอร์โปรเจกต์เดิมบน Windows เพื่อย้ายตารางเวลา กฎควบคุมแอร์ตามจำนวนคน และ Flow เดิม

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-BimClub.ps1 -ImportFrom "C:\Smart_University_Web"
```

ตัวนำเข้าคัดลอกไฟล์ `data/login-account.json`, `data/ac-schedules.json`, `data/ac-occupancy.json`, `node-red/runtime/flows.json`, `flows_cred.json` และ `.config.runtime.json` ไปยังโฟลเดอร์ `seed/` เมื่อ Docker volume มีไฟล์นั้นแล้ว ข้อมูลใน volume จะถูกใช้ต่อ ในโหมด `fixed` ระบบใช้บัญชีที่กำหนดไว้ในอิมเมจ

บนเซิร์ฟเวอร์ Linux ให้วางไฟล์จาก `data/` ที่ต้องการย้ายไว้ใน `seed/web/` และวาง `flows.json`, `flows_cred.json` กับ `.config.runtime.json` ไว้ใน `seed/node-red/` ก่อนเริ่มชุดใหม่ครั้งแรก เก็บไฟล์เหล่านี้ไว้บนเครื่องที่ใช้รันระบบ

หาก Node-RED เดิมใช้ user directory อื่น ให้นำ `flows.json`, `flows_cred.json` และ `.config.runtime.json` จาก directory นั้นมาวางใน `seed/node-red/` ก่อนเริ่มครั้งแรก

เซสชันเก็บในหน่วยความจำและต้องเข้าสู่ระบบใหม่หลังรีสตาร์ตเว็บ ตารางเวลาและกฎควบคุมแอร์ตามจำนวนคนเก็บใน `bimclub_web_data` ส่วน Flow และการตั้งค่า Node-RED เก็บใน `bimclub_node_red_data` เก็บสำรอง volumes นี้ก่อนย้ายเครื่องหรือล้าง Docker Desktop

หากต้องการเลือกใช้ PostgreSQL กลางในอนาคต ดู [คู่มือฐานข้อมูล](DATABASE.md)

## Cloudflare และ CiRA

Windows Cloudflare service เดิมเชื่อมที่ `127.0.0.1:3000` ได้ต่อ ใช้ Worker, Tunnel และ URL เดิม อินเทอร์เน็ตยังต้องพร้อมสำหรับ Cloudflare และ MQTT ที่ `broker.emqx.io`

CiRA CORE ส่งจำนวนคนที่ MQTT `broker.emqx.io:1883` Topic `spu/classroom/room/person` และ payload `{"total_people":2}` ตามเดิม Node-RED จะส่งต่อไป `spu/classroom/cira`

ถ้าเพิ่ม Skeleton ภายหลัง ให้ CiRA บน Windows ส่งเฟรมไป `http://127.0.0.1:1880/cira-pose-frame` ตาม [รูปแบบ Pose ของโปรเจกต์](CIRA_ACTIVITY.md) ตัว CiRA CORE และ ESP32 ทำงานบนอุปกรณ์ของตน ส่วน Docker ชุดนี้รับผลเข้า Node-RED และเว็บ

พอร์ตเว็บและ editor ผูกที่ loopback ของเครื่องเซิร์ฟเวอร์ การเข้าเว็บจากภายนอกใช้ Cloudflare HTTPS ได้ตามเดิม

## เปิดใช้กราฟ DHT22 และกฎตามจำนวนคน

- เมื่อเริ่มบริการบน volume Node-RED ใหม่โดยไม่มี Flow นำเข้า ระบบจะสร้างแท็บ **CiRA CORE → Classroom Web** และ **DHT22 • Classroom Environment** ให้พร้อมกัน
- หากอัปเดตจาก volume เดิมหรือนำเข้า Flow เดิม ให้เปิด editor แล้วดูว่ามีแท็บ **DHT22 • Classroom Environment** หรือยัง หากยังไม่มี ให้นำเข้า JSON เป็นแท็บใหม่แล้ว Deploy แบบ **Modified Nodes** [ไฟล์ Flow DHT22](node_red_dht22_environment_flow.json) · [คู่มือตั้งค่า ESP32 และ MQTT](node-red/DHT22.md)
- เมื่อ DHT22 ส่งค่าพร้อมรหัส A/B ผ่าน Flow เว็บจะแสดงเส้นตามเซนเซอร์ที่มีข้อมูลสด หาก ESP32 ยังส่งค่าผ่าน topic อุณหภูมิเดิม กราฟจะแสดง **ตรวจพบเซนเซอร์ 1 ตัว (ช่องเดิม)** เมื่อมีข้อมูลสด
- ในเว็บเปิด **ควบคุมแอร์ตามจำนวนคน** เพื่อเลือกเปิดแอร์เมื่อพบคนหรือปิดหลังห้องว่างตามเวลาที่ตั้ง กฎทำงานที่เซิร์ฟเวอร์ขณะที่มีข้อมูล CiRA และสถานะ ESP32 ล่าสุด [คู่มือตั้งกฎ](AC_SCHEDULES.md#ควบคุมแอร์ตามจำนวนคน)

หากมีเฉพาะอิมเมจที่รันบนเซิร์ฟเวอร์ สามารถคัดลอกไฟล์ Import DHT22 จากคอนเทนเนอร์ `node-red` ลงโฟลเดอร์ปัจจุบันได้

```sh
docker compose cp node-red:/opt/bimclub/node-red/imports/node_red_dht22_environment_flow.json .
```

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

ถ้ารันจากซอร์ส ให้คัดลอกโค้ดรุ่นใหม่มาในโฟลเดอร์เดิมและรัน `docker compose build` ให้สำเร็จก่อน จากนั้นรันคำสั่งด้านล่างเพื่อสร้างเว็บกับ Node-RED พร้อมกันโดยใช้ named volumes เดิม คำสั่ง `down` ในตัวอย่างจะหยุดบริการชั่วคราวระหว่างอัปเดต [รายละเอียด `docker compose down`](https://docs.docker.com/reference/cli/docker/compose/down/)

```sh
docker compose down
docker compose up -d --no-build --pull never --wait --wait-timeout 180
docker compose ps
```

หากต้องการหยุดหรือเปิดคอนเทนเนอร์ชุดที่ติดตั้งอยู่ ใช้คำสั่งต่อไปนี้ตามที่ต้องการ

```powershell
docker compose stop
docker compose start
```

## สร้างแพ็กเกจจากโปรเจกต์บน Mac

ใช้ Python 3.11 ขึ้นไป และเปิด Docker ก่อนแพ็ก

```sh
python3 scripts/package-docker.py
```

สคริปต์ build image แบบ Linux/amd64 บันทึก image ทั้งสองเป็น tar แล้วรวมเป็น ZIP ที่ `dist/bimclub-docker-ready-login-windows-amd64.zip` พร้อม SHA-256 การ build ครั้งแรกดาวน์โหลด base image และ Python/npm packages หากมีน้ำหนักเสียงที่ครบอยู่ในโปรเจกต์ จะนำมาใช้ใน image

ใช้ `--no-build` เพื่อ export image ที่ build และทดสอบแล้ว หรือ `--include-data` เพื่อใส่ตารางเวลา กฎควบคุมแอร์ตามจำนวนคน และข้อมูลส่วนตัวอื่นจากเครื่องที่แพ็กลงใน `seed/` ด้วย แพ็กเกจปกติใช้บัญชีที่กำหนดไว้ใน image ได้ทันที และมีไฟล์ Flow DHT22 พร้อมคู่มือสำหรับนำเข้าใน volume เดิม

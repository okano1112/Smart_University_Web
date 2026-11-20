# ดูภาพกล้อง RTSP ในแดชบอร์ด

MediaMTX ดึงสตรีม RTSP แบบ TCP เมื่อเริ่มดูภาพ แล้วส่ง HLS ให้เว็บผ่าน `127.0.0.1:8888` ภายในเครือข่ายของคอนเทนเนอร์ เว็บให้ผู้ใช้ที่เข้าสู่ระบบอ่านสตรีมผ่าน `/camera/classroom/index.m3u8` ค่ากล้องอยู่ใน `camera.env` บนเครื่องเซิร์ฟเวอร์ [การรับสตรีมจากกล้อง RTSP](https://mediamtx.org/docs/publish/rtsp-cameras-and-servers)

## ตั้งค่าบนเครื่องเซิร์ฟเวอร์

1. ตรวจว่าเครื่องเซิร์ฟเวอร์เข้าถึง IP ของกล้องที่พอร์ต `554` ได้ บน Windows ใช้ `Test-NetConnection CAMERA_IP -Port 554` ส่วน Linux ใช้ `nc -vz -w 3 CAMERA_IP 554` หากติดตั้ง `nc` แล้ว
2. ใช้ `camera.env` ที่ตั้งไว้บนเครื่องเซิร์ฟเวอร์ หากยังไม่มี ให้คัดลอก [`camera.env.example`](camera.env.example) ไปเป็น `camera.env` ข้าง `compose.yaml` แล้วใส่ URL กล้องใน `MTX_PATHS_CLASSROOM_SOURCE` เข้ารหัสอักขระพิเศษของชื่อผู้ใช้และรหัสผ่านแบบ URL encoding เก็บไฟล์นี้บนเซิร์ฟเวอร์ และใช้ `docker compose --profile camera config --quiet` เมื่อตรวจการตั้งค่า [ตัวแปรสภาพแวดล้อม MediaMTX](https://mediamtx.org/docs/features/configuration)
3. จากโฟลเดอร์โปรเจกต์ ดึงอิมเมจกล้องและสร้างอิมเมจเว็บก่อนเปิดบริการ

   ```sh
   docker compose --profile camera pull camera
   docker compose build
   docker compose --profile camera up -d --no-build --pull never
   docker compose --profile camera ps
   ```

   สำหรับเซิร์ฟเวอร์ที่อัปเดตจากชุดเดิม ให้รัน `docker compose --profile camera down` หลัง build เสร็จและก่อน `up` เพื่อสร้างคอนเทนเนอร์ที่ใช้เครือข่ายร่วมกันใหม่ แล้วใช้ named volumes เดิม หากติดตั้งจาก ZIP ที่มีอิมเมจเว็บและ Node-RED อยู่แล้ว ให้รัน `Start-BimClub.cmd` จากนั้นดึงอิมเมจ `camera` และใช้คำสั่ง `up` ข้างต้น
4. เข้าสู่ระบบในเว็บแล้วกดเปิดภาพในแผงกล้อง หากเบราว์เซอร์เปิดภาพไม่ได้ ให้ตรวจจากเครื่องเซิร์ฟเวอร์ว่ากล้องตอบพอร์ต `554` และลองตั้งสตรีมกล้องเป็น H.264 [การเล่น HLS บนเบราว์เซอร์](https://mediamtx.org/docs/read/web-browsers)

หากเปลี่ยน URL กล้อง ให้แก้ `camera.env` แล้วสร้างคอนเทนเนอร์กล้องใหม่ด้วย `docker compose --profile camera up -d --force-recreate --no-deps camera`

# Local voice runtime

ระบบคำสั่งเสียงปัจจุบันใช้ `models/ac_voice_model_int8.tflite` บนเครื่องเซิร์ฟเวอร์ ไม่มีการเรียก Groq/Whisper/LLM ภายนอก และไม่มี cloud fallback แม้โมเดลทำงานไม่ได้ `.env` เดิมคงไว้แต่ระบบเสียงไม่ใช้ GROQ_API_KEY แล้ว

## ติดตั้งบนเครื่องใหม่

ใช้ Python 3.12 (TensorFlow ที่ pin ไว้ไม่รองรับ Python 3.14):

```sh
python3.12 -m venv .venv-voice
.venv-voice/bin/python -m pip install -r offline-voice/requirements.txt
npm install
npm start
```

Windows ใช้ `.venv-voice\Scripts\python.exe` แทน หากมี interpreter อื่นตั้ง `VOICE_PYTHON` เป็น absolute path ได้ ต้องมี TensorFlow และ Librosa ตาม requirements ใน interpreter นั้น การติดตั้งต้องใช้อินเทอร์เน็ต แต่การทำนายไม่ใช้ AI API ภายนอก หน้าเว็บเดิมยังมี CDN และ MQTT broker ตามการตั้งค่า จึงไม่ได้หมายถึงทั้งเว็บทำงานแบบตัดอินเทอร์เน็ตทุกส่วน

ครั้งแรกเริ่มช้าระหว่างโหลด TensorFlow/compile DSP รอข้อความ `Local TFLite พร้อมรับคำสั่ง` ก่อนใช้งาน จากนั้นใช้ worker เดิมซ้ำ ไม่โหลดโมเดลใหม่ทุกคำสั่ง Worker จำกัด 2 threads และคิวสูงสุด 4 งาน ยกเลิกเซสชันแล้วไม่คืนคำสั่งเก่ามาส่งอุปกรณ์

## วิธีพูดและการแมปคำสั่ง

ใช้ปุ่มกดพูดเดิม แล้วพูดคำสั่งภาษาไทยสั้น ๆ โดยไม่เติมชื่อ Engi:

| คลาส | ตัวอย่าง | ผลลัพธ์ |
|---|---|---|
| 0_ON | เปิดแอร์ | เปิด รักษาอุณหภูมิ/โหมด/พัดลมเดิม |
| 1_OFF | ปิดแอร์ | ปิด รักษาค่าอื่น |
| 2_TEMP_UP | เพิ่มอุณหภูมิ | เพิ่ม 1°C ไม่เกิน 27°C และเปิดแอร์ |
| 3_TEMP_DOWN | ลดอุณหภูมิ | ลด 1°C ไม่ต่ำกว่า 21°C และเปิดแอร์ |
| 4_PRESET_TURBO | โหมดเทอร์โบ | เปิด COOL 21°C พัดลม HIGH |
| 5_PRESET_ECO | โหมดประหยัด | เปิด COOL 25°C พัดลม AUTO |
| 6_BACKGROUND | เสียงอื่น | ไม่ส่งคำสั่ง |

ปุ่มฟังต่อเนื่องตำแหน่งเดิมเป็น opt-in และใช้ preference ใหม่ ไม่ใช้ค่าเปิดฟังชื่อจากระบบเก่า เพราะโมเดลนี้ไม่มี wake-word gate โหมดนี้ฟังคำสั่งโดยตรง ไม่มีการตรวจ Engi/คำอังกฤษ/อุณหภูมิตัวเลข/พัดลมแยกระดับ เสียงนอกรูปแบบอาจจำแนกผิดแม้คะแนนสูง แนะนำกดพูดสำหรับทดลองจริง ไม่มีการอ้างว่า threshold เป็นเปอร์เซ็นต์ความแม่นยำ

## โมเดลและข้อมูลประกอบ

โมเดลคัดลอกจากไฟล์ผู้ใช้ ตรวจไบต์ตรงกับ header `.h` ของผู้ใช้ ค่า mean/std และ labels เก็บใน `models/ac_voice_model.json` ใช้ค่าปัด 6 ตำแหน่งที่มีใน header ซึ่งไม่ใช่ full precision ของ notebook

Input float32 `[1,41,13,1]`, output float32 `[1,7]`; ภายใน quantized INT8 ไม่ใช่ INT8 input/output ทั้งชุด ใช้ MFCC ตาม Librosa 0.11: 16 kHz, 24000 samples, n_mfcc=13, n_fft=512, hop=600 และค่า defaults ที่ระบุไว้ใน worker ห้ามเปลี่ยน DSP โดยไม่ตรวจเทียบชุดฝึก

รับเฉพาะ PCM16 WAV mono 16 kHz ตรวจความยาวและข้อมูลจริง ไม่เชื่อ header อย่างเดียว ปฏิเสธเสียงเงียบ/เสียงยาวแทนการตัดคำสั่งโดยไม่บอก ใช้ confidence >=0.90 และ top-two margin >=0.25 เป็นค่าเริ่มต้น ยังไม่ผ่าน calibration กับเสียงผู้ใช้จริง

ทดสอบอัตโนมัติ `npm test` ครอบคลุมคำสั่ง การยกเลิก การไม่ส่งซ้ำ และปิดการ fetch ภายนอกใน HTTP test ผลกับชุดเสียงสังเคราะห์ของผู้ใช้เป็นเพียง compatibility check ไม่ใช่ independent accuracy test หรือหลักฐานความแม่นยำในห้องจริง

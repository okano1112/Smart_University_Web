"""One-time download of local Thai ASR weights. Never called by the server."""
from pathlib import Path
import hashlib
import json
from huggingface_hub import snapshot_download
root = Path(__file__).resolve().parents[1]
target=root/'models/whisper-th-small'
snapshot_download('Thaweewat/whisper-th-small-ct2',local_dir=target,
    allow_patterns=['config.json','model.bin','vocabulary.*','preprocessor_config.json','README.md'])
# Fine-tuned weights keep the original Whisper-small token IDs. Bundle its tokenizer
# explicitly so faster-whisper cannot attempt a runtime tokenizer download.
snapshot_download('Systran/faster-whisper-small',local_dir=target,allow_patterns=['tokenizer.json'])
manifest={'source':'Thaweewat/whisper-th-small-ct2','base_model':'biodatlab/whisper-th-small-combined',
          'tokenizer_source':'Systran/faster-whisper-small','files':{}}
for name in ['model.bin','config.json','vocabulary.txt','tokenizer.json']:
    p=target/name
    if p.exists():manifest['files'][name]=hashlib.sha256(p.read_bytes()).hexdigest()
(target/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Local Thai Whisper files ready')

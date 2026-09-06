import httpx
import json

LM_STUDIO_BASE_URL = "http://localhost:1234/v1"

def test_chat():
    payload = {
        "model": "openai/gpt-oss-20b",
        "messages": [{"role": "user", "content": "What is 2+2?"}],
        "stream": False,
        "max_tokens": 5,
        "extra_body": {
            "chat_template_kwargs": {
                "enable_thinking": False
            }
        }
    }
    print("Testing extra_body with chat_template_kwargs")
    try:
        resp = httpx.post(f"{LM_STUDIO_BASE_URL}/chat/completions", json=payload, timeout=2)
        if resp.status_code == 200:
            print("  Status 200 OK")
        else:
            print(f"  Error HTTP {resp.status_code}: {resp.text[:100]}")
    except Exception as e:
        print(f"  Exception: {e}")

if __name__ == "__main__":
    test_chat()

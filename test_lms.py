import httpx
import json

LM_STUDIO_BASE_URL = "http://localhost:1234/v1"

def test_chat(reasoning_format):
    payload = {
        "model": "openai/gpt-oss-20b",
        "messages": [{"role": "user", "content": "What is 2+2?"}],
        "stream": False,
        "max_tokens": 10
    }
    
    if reasoning_format == "dict_enabled":
        payload["reasoning"] = {"enabled": True, "effort": "high"}
    elif reasoning_format == "dict_disabled":
        payload["reasoning"] = {"enabled": False, "effort": "none"}
    elif reasoning_format == "reasoning_false":
        payload["reasoning"] = False
    elif reasoning_format == "reasoning_off":
        payload["reasoning"] = "off"
    elif reasoning_format == "openai_low":
        payload["reasoning_effort"] = "low"
    elif reasoning_format == "openai_none":
        payload["reasoning_effort"] = "none"
        
    print(f"Testing {reasoning_format}")
    try:
        resp = httpx.post(f"{LM_STUDIO_BASE_URL}/chat/completions", json=payload, timeout=2)
        if resp.status_code == 200:
            data = resp.json()
            print("  Status 200 OK")
        else:
            print(f"  Error HTTP {resp.status_code}: {resp.text[:100]}")
    except Exception as e:
        print(f"  Exception: {e}")


if __name__ == "__main__":
    for fmt in ["none", "dict_disabled", "reasoning_false", "reasoning_off", "openai_none"]:
        test_chat(fmt)

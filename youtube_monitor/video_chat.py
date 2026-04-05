"""
Video Chat: Gemini-powered conversations about YouTube videos.
Uses Gemini's multi-turn chat with the video as persistent context.
"""

import asyncio
import logging
import uuid
from datetime import datetime

import google.genai as genai
from google.genai import types

logger = logging.getLogger(__name__)

# In-memory chat sessions: session_id -> {video_id, chat, created_at, messages, title, ...}
_sessions: dict = {}


def _get_gemini_client():
    """Get the Gemini client initialized by the worker."""
    from youtube_monitor.worker import _gemini_client
    return _gemini_client


def _get_data_api_key():
    from youtube_monitor.worker import _youtube_data_api_key
    return _youtube_data_api_key


def _fetch_video_info(video_id: str) -> dict:
    """Fetch video snippet from YouTube Data API."""
    api_key = _get_data_api_key()
    if not api_key:
        return {"video_id": video_id, "title": video_id, "channel_name": "", "thumbnail": ""}
    try:
        from googleapiclient.discovery import build
        from youtube_monitor import yt_memory_cache
        youtube = build('youtube', 'v3', developerKey=api_key, cache=yt_memory_cache)
        resp = youtube.videos().list(part='snippet', id=video_id).execute()
        items = resp.get('items', [])
        if items:
            s = items[0]['snippet']
            thumbs = s.get('thumbnails', {})
            thumb_url = (thumbs.get('medium') or thumbs.get('default') or {}).get('url', '')
            return {
                "video_id": video_id,
                "title": s.get('title', video_id),
                "channel_name": s.get('channelTitle', ''),
                "thumbnail": thumb_url,
            }
    except Exception as e:
        logger.warning(f"[YT-CHAT] Failed to fetch video info for {video_id}: {e}")
    return {"video_id": video_id, "title": video_id, "channel_name": "", "thumbnail": ""}


async def create_chat_session(video_id: str) -> dict:
    """Create a new chat session with a YouTube video loaded as context."""
    client = _get_gemini_client()
    if not client:
        raise RuntimeError("Gemini client not initialized")

    # Fetch video metadata
    info = await asyncio.get_event_loop().run_in_executor(None, _fetch_video_info, video_id)

    # Create a Gemini chat with the video as initial context
    video_url = f"https://www.youtube.com/watch?v={video_id}"

    chat = client.chats.create(
        model='gemini-2.5-flash',
        history=[
            types.Content(
                role='user',
                parts=[
                    types.Part(file_data=types.FileData(file_uri=video_url)),
                    types.Part(text="I'm going to ask you questions about this video. "
                                   "Please analyze it thoroughly and be ready to answer. "
                                   "Respond in the same language as my questions."),
                ]
            ),
            types.Content(
                role='model',
                parts=[
                    types.Part(text="I've analyzed the video and I'm ready to answer your questions. "
                                   "Feel free to ask anything about the content, key points, "
                                   "specific topics discussed, or anything else you'd like to know.")
                ]
            ),
        ],
    )

    session_id = str(uuid.uuid4())[:8]
    _sessions[session_id] = {
        "session_id": session_id,
        "video_id": video_id,
        "chat": chat,
        "created_at": datetime.utcnow().isoformat(),
        "messages": [],
        **info,
    }

    logger.info(f"[YT-CHAT] Created session {session_id} for video {video_id}")
    return {
        "session_id": session_id,
        **info,
    }


async def send_chat_message(session_id: str, message: str) -> str:
    """Send a message in an existing chat session and return the AI reply."""
    session = _sessions.get(session_id)
    if not session:
        raise ValueError(f"Session {session_id} not found")

    chat = session["chat"]

    # Send message (sync API, run in executor)
    def _send():
        response = chat.send_message(message)
        return response.text.strip()

    reply = await asyncio.get_event_loop().run_in_executor(None, _send)

    # Store in session history
    session["messages"].append({"role": "user", "text": message})
    session["messages"].append({"role": "assistant", "text": reply})

    return reply


def get_chat_session(session_id: str) -> dict | None:
    """Get session info (without the chat object)."""
    session = _sessions.get(session_id)
    if not session:
        return None
    return {k: v for k, v in session.items() if k != "chat"}


def delete_chat_session(session_id: str):
    """Remove a chat session."""
    if session_id in _sessions:
        del _sessions[session_id]
        logger.info(f"[YT-CHAT] Deleted session {session_id}")


async def refine_text(text: str, instruction: str = "") -> str:
    """Refine/polish text using Gemini (standalone, no video context)."""
    client = _get_gemini_client()
    if not client:
        raise RuntimeError("Gemini client not initialized")

    prompt = instruction or (
        "Refine the following content into a well-structured, informative message "
        "suitable for a WhatsApp group. Keep it clear, concise, and professional. "
        "Use appropriate formatting (bold with *, bullet points, etc). "
        "Preserve the original language. Do not add information that isn't in the source."
    )

    def _refine():
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=f"{prompt}\n\n---\n\n{text}",
        )
        return response.text.strip()

    return await asyncio.get_event_loop().run_in_executor(None, _refine)

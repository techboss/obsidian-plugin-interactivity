# This file is a part of Obsidian's Interactivity plugin

import logging
import re
import json
from pathlib import Path

_HAS_OPENAI = False
openai = None

try:
	import openai as _openai
	openai = _openai

	__open_ai_min_ver = "1.0.0"
	installed_parts = list(map(int, openai.__version__.split('.')))
	required_parts = list(map(int, __open_ai_min_ver.split('.')))

	_version_ok = True
	for installed_part, required_part in zip(installed_parts, required_parts):
		if installed_part < required_part:
			_version_ok = False
			break

	if _version_ok:
		_HAS_OPENAI = True
		__httpx_logger = logging.getLogger("httpx")
		__httpx_logger.setLevel(logging.WARNING)
except ImportError:
	pass

# Try to import obs_prompt_expand
_HAS_EXPAND = False
expand = None
try:
	from obs_prompt_expand import expand as _expand
	expand = _expand
	_HAS_EXPAND = True
except ImportError:
	try:
		from .obs_prompt_expand import expand as _expand
		expand = _expand
		_HAS_EXPAND = True
	except ImportError:
		pass

# ---------------------------------------------------------------------------
# CONFIG: where your context notes live (EDIT THIS)
# ---------------------------------------------------------------------------

# Point this to a directory inside your vault where you'll keep context files,
# e.g. /Users/anthony/Obsidian/MainVault/_chat_context
VAULT_CONTEXT_DIR = Path("/Users/anthony/Documents/Obsidian/Personal/_chat_context")  # <-- EDIT ME

# In that directory, you'll create files like:
#   running-context.md
#   aws-context.md
#   ea-context.md
# etc.


# ---------------------------------------------------------------------------
# Persistent context memory (global + per-context)
# ---------------------------------------------------------------------------

__chat_messages = []  # in-memory for the *current* context


def _safe_context_id(context_id: str) -> str:
	"""Normalize context id to a safe filename fragment."""
	return re.sub(r'[^A-Za-z0-9_\-]', '_', context_id)


def _get_memory_file(context_id: str = None) -> Path:
	"""Return the appropriate memory file path for a given context."""
	if context_id:
		safe_id = _safe_context_id(context_id)
		name = f"chat_memory_{safe_id}.json"
	else:
		name = "chat_memory_global.json"
	return Path(__file__).with_name(name)


def _load_memory(context_id: str = None, save_context: bool = True) -> None:
	"""Load chat history for the given context into __chat_messages."""
	global __chat_messages

	if not save_context:
		__chat_messages = []
		return

	mem_file = _get_memory_file(context_id)
	if not mem_file.exists():
		__chat_messages = []
		return

	try:
		data = json.loads(mem_file.read_text(encoding="utf-8"))
		if isinstance(data, list):
			__chat_messages = [
				m for m in data
				if isinstance(m, dict)
				and "role" in m
				and "content" in m
			]
		else:
			__chat_messages = []
	except Exception as e:
		logging.warning(f"Failed to load chat memory from {mem_file}: {e}")
		__chat_messages = []


def _save_memory(context_id: str = None) -> None:
	"""Save __chat_messages to disk for the given context."""
	mem_file = _get_memory_file(context_id)
	try:
		mem_file.write_text(
			json.dumps(__chat_messages, ensure_ascii=False, indent=2),
			encoding="utf-8"
		)
	except Exception as e:
		logging.warning(f"Failed to save chat memory to {mem_file}: {e}")


# ---------------------------------------------------------------------------
# Context-id and context-text extraction
# ---------------------------------------------------------------------------

def _extract_context_id(prompt: str) -> str | None:
	"""
	Look for a context id in YAML frontmatter or the first few lines.

	Supported patterns:
	- chat_context: running
	- context: running
	- @context: running
	"""
	# Try to extract YAML frontmatter at top of prompt
	m = re.match(r"---\s*\n(.*?)\n---\s*\n", prompt, re.DOTALL)
	if m:
		header_text = m.group(1)
	else:
		# Fallback: first 10 lines as "header-ish"
		header_text = "\n".join(prompt.splitlines()[:10])

	patterns = [
		r"chat_context\s*:\s*([A-Za-z0-9_\-]+)",
		r"context\s*:\s*([A-Za-z0-9_\-]+)",
		r"@context\s*:\s*([A-Za-z0-9_\-]+)",
	]

	for pat in patterns:
		m2 = re.search(pat, header_text)
		if m2:
			return m2.group(1).strip()

	return None


def _get_context_text(context_id: str | None) -> str | None:
	"""
	Read long-term context text from a markdown file in VAULT_CONTEXT_DIR,
	named '<context_id>-context.md'.

	Example:
	- context_id: 'running' -> running-context.md
	"""
	if not context_id:
		return None

	if not VAULT_CONTEXT_DIR:
		return None

	try:
		context_dir = VAULT_CONTEXT_DIR
		if not context_dir.exists():
			return None

		filename = f"{_safe_context_id(context_id)}-context.md"
		context_path = context_dir / filename

		if not context_path.exists():
			return None

		text = context_path.read_text(encoding="utf-8")

		# Optional: limit to avoid blowing the context window
		max_chars = 8000
		if len(text) > max_chars:
			text = text[-max_chars:]

		return text
	except Exception as e:
		logging.warning(f"Failed to read context file for '{context_id}': {e}")
		return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

# sends the query to ChatGPT 4o
def chat4(prompt: str, system: str = None, save_context: bool = True) -> None:
	chat(prompt, system, save_context, 'gpt-4o')

def chat5(prompt: str, system: str = None, save_context: bool = True) -> None:
	chat(prompt, system, save_context, 'gpt-5.2')

# sends the query to ChatGPT
def chat(prompt: str, system: str = None, save_context: bool = True, model: str = 'gpt-5.2') -> None:
	global __chat_messages

	if not _HAS_OPENAI:
		print("Error: openai not installed. Run: pip install openai")
		return

	# Expand @garmin tokens (e.g., @garmin latest, @garmin 2025-12-25)
	if _HAS_EXPAND and expand:
		prompt = expand(prompt).rstrip('\n')

	if not openai.api_key:
		print("Error: OpenAI API key not set. Set openai.api_key first.")
		return

	# Determine topic/context from the prompt (frontmatter or marker)
	context_id = _extract_context_id(prompt)

	# Load context-specific memory
	_load_memory(context_id, save_context)

	# Load long-term "knowledge" note for this context
	context_text = _get_context_text(context_id)

	client = openai.OpenAI(api_key=openai.api_key)

	msg = []

	# Base system message
	if system:
		msg.append({"role": "system", "content": system})

	# Inject long-term context as an additional system message
	if context_text:
		msg.append({
			"role": "system",
			"content": f"Long-term context for this conversation (topic: '{context_id}'):\n{context_text}"
		})

	# Add conversation history
	if save_context:
		msg += __chat_messages

	# Current user prompt
	msg.append({"role": "user", "content": prompt})

	try:
		completion = client.chat.completions.create(model=model, messages=msg)
	except (
		openai.BadRequestError,
		openai.AuthenticationError,
		openai.PermissionDeniedError,
		openai.NotFoundError,
		openai.UnprocessableEntityError,
		openai.RateLimitError,
		openai.InternalServerError,
		openai.APIConnectionError,
		openai.APITimeoutError
	) as e:
		# If request is too long, trim oldest messages and retry
		if save_context and len(__chat_messages) > 2:
			del __chat_messages[0]
			del __chat_messages[0]
			_save_memory(context_id)
			return chat(prompt, system, save_context, model)
		else:
			raise e

	reply = completion.choices[0].message.content

	if save_context:
		__chat_messages += [
			{"role": "user", "content": prompt},
			{"role": "assistant", "content": reply}
		]
		_save_memory(context_id)

	print(reply + '\n')


# cleans chat history
def clean_chat() -> None:
	"""
	Clear all in-memory and on-disk chat histories (global + all contexts).
	"""
	global __chat_messages
	__chat_messages = []

	# Delete all chat_memory_*.json and chat_memory_global.json next to this file
	try:
		base_dir = Path(__file__).parent
		for mem_file in base_dir.glob("chat_memory_*.json"):
			try:
				mem_file.unlink()
			except Exception as e:
				logging.warning(f"Failed to delete memory file {mem_file}: {e}")
		global_file = base_dir / "chat_memory_global.json"
		if global_file.exists():
			try:
				global_file.unlink()
			except Exception as e:
				logging.warning(f"Failed to delete global memory file {global_file}: {e}")
	except Exception as e:
		logging.warning(f"Failed to clean chat memory files: {e}")

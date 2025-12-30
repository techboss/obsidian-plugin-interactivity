# This file is a part of Obsidian's Interactivity plugin

import os
import time
import logging
import sys
import types
import json
from py_modules import *


debug_info = False
all_package_functions_to_globals = True
available_objects = []

# Global context from JSON messages (accessible in commands)
frontmatter = {}
context = {}
note_path = ""


# prints formatted line
def log(msg, *args, **kwargs) -> None:
    if isinstance(msg, str):
        msg = msg.replace('\r', '').split('\n')
        for i, m in enumerate(msg[1:]):
            msg[i + 1] = ' >> ' + m
        msg = '\n'.join(msg)
    logging.getLogger().info(msg, *args, **kwargs)
    sys.stdout.flush()  # Ensure output is sent immediately


# prints out general information about this script
def info() -> None:
    global available_objects
    log('Python ' + sys.version)
    log('Available objects:' + "".join(['\n' + x for x in available_objects]))


def process_message(line: str) -> str:
    """
    Process incoming message - either JSON or plain text.
    Returns the command to execute.
    Updates global frontmatter, context, and note_path.
    """
    global frontmatter, context, note_path

    line = line.strip()
    if not line:
        return ""

    # Try to parse as JSON
    if line.startswith('{'):
        try:
            msg = json.loads(line)

            # Update globals from message
            frontmatter = msg.get('frontmatter', {})
            context = msg.get('context', {})
            note_path = context.get('notePath', '')

            command = msg.get('command', '')

            if debug_info:
                logging.debug(f"JSON message received:")
                logging.debug(f"  frontmatter: {frontmatter}")
                logging.debug(f"  note_path: {note_path}")
                logging.debug(f"  command: {command[:50]}...")

            return command
        except json.JSONDecodeError:
            # Not valid JSON, treat as plain text
            pass

    # Plain text fallback
    return line


def get_frontmatter(key: str, default=None):
    """Helper to get a frontmatter value with optional default."""
    return frontmatter.get(key, default)


def run_interactive_loop():
    """
    Main input loop for processing messages from Obsidian.
    Handles both JSON protocol and plain text.
    """
    global frontmatter, context, note_path

    while True:
        try:
            line = sys.stdin.readline()
            if not line:  # EOF
                break

            line = line.rstrip('\n\r')
            if not line:
                continue

            command = process_message(line)

            if command:
                # Strip any remaining %%% delimiters that might have slipped through
                command = command.strip()
                if command.startswith('%%%'):
                    command = command[3:]
                if command.endswith('%%%'):
                    command = command[:-3]
                command = command.strip()

                if not command:
                    continue

                try:
                    # Try eval first for expressions
                    result = eval(command)
                    if result is not None:
                        log(str(result))
                except SyntaxError:
                    # Try exec for statements (multi-line code)
                    try:
                        exec(command, globals())
                    except Exception as e:
                        log(f"Error: {e}")
                except Exception as e:
                    log(f"Error: {e}")

        except EOFError:
            break
        except KeyboardInterrupt:
            break
        except Exception as e:
            log(f"Loop error: {e}")


if __name__ == '__main__':
    logger = logging.getLogger()
    logger.setLevel(logging.INFO if debug_info is False else logging.DEBUG)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(logging.Formatter('%(message)s'))

    logger.propagate = False
    logger.handlers = []
    logger.addHandler(console_handler)

    del console_handler

    if all_package_functions_to_globals:
        for n, t in list(globals().items()):
            if isinstance(t, types.FunctionType) and not n.startswith('__'):
                available_objects.append(n)
            if isinstance(t, types.ModuleType) and t.__package__ == 'py_modules':
                for x in dir(t):
                    v = getattr(t, x)
                    if not x.startswith('__'):
                        if x in globals().keys() and isinstance(globals()[x], type(v)):
                            logger.debug('Objects name conflict: ', x)
                        else:
                            globals().update({x: v})
                            available_objects.append(x)

    # Add JSON protocol globals to available objects
    available_objects.extend(['frontmatter', 'context', 'note_path', 'get_frontmatter'])

    # Start the interactive loop (handles both JSON and plain text)
    run_interactive_loop()

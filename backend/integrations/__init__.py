"""Third-party system integrations.

Each sub-package owns one external system and exposes a small, typed surface
to the rest of the app. Routers and services talk to those surfaces, never to
raw HTTP clients — same rule the ``llm`` and ``storage`` packages follow.
"""

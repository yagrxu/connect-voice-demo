"""Minimal Nova Sonic config for the streaming-backend port."""
MODEL_ID = "amazon.nova-2-sonic-v1:0"
SESSION_OPEN_TIMEOUT_S = 10.0


class BedrockOpenError(Exception):
    """Raised when opening the Nova Sonic bidirectional stream fails."""

    def __init__(self, category: str, detail):
        super().__init__(f"{category}: {detail}")
        self.category = category
        self.detail = detail

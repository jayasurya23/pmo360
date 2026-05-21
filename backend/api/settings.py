"""/api/settings — read-only environment + branding info exposed to the React app."""
from fastapi import APIRouter

from config import (
    APP_TITLE, APP_TAGLINE, TOOL_NAME, DEFAULT_TIMEZONE,
    BrandColors, is_local_dev, openai_model,
)


router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def get_settings():
    """Expose branding + non-secret config so the frontend doesn't need to
    hardcode anything that lives in the backend's .env or BrandColors."""
    return {
        "app": {
            "title": APP_TITLE,
            "tagline": APP_TAGLINE,
            "tool_name": TOOL_NAME,
            "timezone": DEFAULT_TIMEZONE,
            "local_dev_mode": is_local_dev(),
        },
        "openai": {
            "model": _safe_openai_model(),
        },
        "brand": {
            "red":        BrandColors.RED,
            "dark_red":   BrandColors.DARK_RED,
            "near_black": BrandColors.NEAR_BLACK,
            "dark_gray":  BrandColors.DARK_GRAY,
            "light_gray": BrandColors.LIGHT_GRAY,
            "near_white": BrandColors.NEAR_WHITE,
            "brown":      BrandColors.BROWN,
            "bright_red": BrandColors.BRIGHT_RED,
            "blue":       BrandColors.BLUE,
            "green":      BrandColors.GREEN,
            "bright_green": BrandColors.BRIGHT_GREEN,
            "gold":       BrandColors.GOLD,
            "status": {
                "open":      BrandColors.STATUS_OPEN,
                "pending":   BrandColors.STATUS_PENDING,
                "completed": BrandColors.STATUS_COMPLETED,
                "cancelled": BrandColors.STATUS_CANCELLED,
            },
        },
    }


def _safe_openai_model():
    try:
        return openai_model()
    except Exception:
        return None

import os

import yaml

HERE = os.path.dirname(__file__)


def test_yaml_maps_all_categories_under_volume():
    cfg = yaml.safe_load(open(os.path.join(HERE, "..", "worker", "extra_model_paths.yaml")))
    sec = cfg["runpod_volume"]
    assert sec["base_path"] == "/runpod-volume/models"
    for k in ("diffusion_models", "text_encoders", "vae", "latent_upscale_models", "loras", "model_patches"):
        assert sec[k] == f"{k}/"

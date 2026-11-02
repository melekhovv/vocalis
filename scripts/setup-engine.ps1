# Creates engine\.venv (Python 3.11 + PyTorch CUDA) from the locked dependencies.
. "$PSScriptRoot\_common.ps1"
$uv = Get-Uv
Push-Location $Engine
try {
    & $uv sync --frozen --python 3.11
    & $EnginePython -c "import torch; print('torch', torch.__version__, '| CUDA:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"
} finally { Pop-Location }

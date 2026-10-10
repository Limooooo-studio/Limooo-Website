"""cairosvg 的最小本地 stub（cairosvg 2.8.2 不带 py.typed，也不在 typeshed 里）。

只声明仓库实际用到的那一个函数：`src/build.py` 的
`cairosvg.svg2png(url=...)`。签名逐参数抄自 site-packages 里那份
`cairosvg/__init__.py`（2.8.2），不是凭印象写的。

为什么不写 `ignore_missing_imports = true`：那会把**所有**第三方包的缺失
一次性关掉（以后引进来一个真没类型的包也不会再提醒）。为什么不写
`# type: ignore[import-not-found]`：那样调用点拿到的 module 是 Any，
`svg2png` 的返回值也就没有类型，等于在这条链路上放弃检查。
"最小 stub + 显式调用点" 两者都能保住。

返回类型固定写 `bytes`：build.py 只在 `write_to` 缺省（即要字节流）时调用它；
真要写文件时该走 `write_to` 的 `None` 分支，届时要给这里补重载。
"""

from typing import Any

def svg2png(
    bytestring: bytes | None = ...,
    *,
    file_obj: Any = ...,
    url: str | None = ...,
    dpi: float = ...,
    parent_width: float | None = ...,
    parent_height: float | None = ...,
    scale: float = ...,
    unsafe: bool = ...,
    background_color: str | None = ...,
    negate_colors: bool = ...,
    invert_images: bool = ...,
    write_to: Any = ...,
    output_width: float | None = ...,
    output_height: float | None = ...,
) -> bytes: ...

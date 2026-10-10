# Limooo - serverless personal website and admin system
#
# Copyright (C) 2026 Limooo <https://limooo.cn/>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""Apple Account 密码 Fernet 加解密测试（测试专用 key）。"""

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
TOKEN_FIXTURE = Path(__file__).parent / "fixtures" / "fernet_token.txt"
# W5-3：由 `functions/_lib/fernet.ts` 的 `fernetEncrypt` 用同一把 key 生成
# （明文 `8.8.8.8`，生成命令见 docs/22 执行记录）。生产真正依赖的方向是
# TS 加密（`tracking.ts` 写 `ip_enc`）→ Python 解密（`ops/check_ip_rays.py`）。
TS_TOKEN_FIXTURE = Path(__file__).parent / "fixtures" / "fernet_token_ts.txt"


def test_fixed_ticket_round_trip():
    key = TEST_KEY
    fernet = Fernet(key.encode())
    token = fernet.encrypt(b"hello-limooo").decode()
    assert fernet.decrypt(token.encode()) == b"hello-limooo"


def test_wrong_key_rejected():
    token = Fernet(TEST_KEY.encode()).encrypt(b"secret").decode()
    # 这个 key 解出来是 33 字节，Fernet 在构造时就拒绝；收窄到真实异常类型，
    # 不用裸 Exception 把「任何错误都算对」的假绿放进来。
    with pytest.raises(ValueError, match="32 url-safe base64-encoded bytes"):
        Fernet(b"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWZ9").decrypt(token.encode())


def test_fixture_is_python_decryptable():
    token = TOKEN_FIXTURE.read_text(encoding="utf-8").strip()
    assert Fernet(TEST_KEY.encode()).decrypt(token.encode()) == b"hello-limooo"


def test_ts_generated_fixture_is_python_decryptable():
    """W5-3：TS 侧 `fernetEncrypt` 的产物必须能被 Python `Fernet` 解开。

    锁的是**跨语言边界**而不是 `cryptography` 自测：`functions/_lib/tracking.ts`
    把访客 IP 加密进 `visitor_rollups.ip_enc`，`ops/check_ip_rays.py` 用 Python 解回来。
    该边界依赖 TS 侧保留 base64 `=` 填充——`Fernet.decrypt()` 内部走
    `base64.urlsafe_b64decode`，缺填充抛 `InvalidToken`（实测），表现为「所有 IP 都无记录」。
    vitest 侧（`functions/_lib/fernet.test.ts`）断言当前实现仍带填充，这条断言
    「带填充的真实 TS token」Python 解得开；两半合起来才锁住整条链路。
    """
    token = TS_TOKEN_FIXTURE.read_text(encoding="utf-8").strip()
    assert len(token) % 4 == 0
    assert Fernet(TEST_KEY.encode()).decrypt(token.encode()) == b"8.8.8.8"


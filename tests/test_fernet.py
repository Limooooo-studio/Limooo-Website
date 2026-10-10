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

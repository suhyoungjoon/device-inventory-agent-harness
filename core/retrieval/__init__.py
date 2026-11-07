"""검색 모듈 (M15-C): 문장으로 된 지식(규정·과거 사례·현장 의견)을 에이전트가 도구로 찾아 인용하게 한다.

숫자는 지금처럼 집계 도구가 맡는다. 검색은 벡터 + 키워드(BM25) 혼합, 순위 합치기(RRF), 메타데이터 필터.
임베딩 제공사가 없으면 키워드만 쓴다. 저장은 SQLite 하나 (벡터는 JSON, 코사인은 파이썬).
문서 종류와 메타데이터 필드는 도메인 팩이 선언한다 (knowledge/index.yaml). 코어는 도메인을 모른다.
"""

from .documents import load_knowledge, parse_markdown
from .index import Chunk, Index
from .session import open_index, prepare
from .tool import citation_errors, retrieval_meta, retrieval_summary, search_tool

__all__ = ["Chunk", "Index", "citation_errors", "load_knowledge", "parse_markdown", "open_index", "prepare", "retrieval_meta",
           "retrieval_summary", "search_tool"]

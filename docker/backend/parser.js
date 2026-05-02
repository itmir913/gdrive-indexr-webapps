/** 쿼리 문자열을 토큰화 */
function tokenize(query) {
    query = query.replace(/\s{2,}/g, ' ').trim();
    if (!query) return [];
    query = query.replace(/\s*(and|or|not)\s*/gi, '|||$1|||');
    query = query.replace(/\s*([()])\s*/g, '|||$1|||');

    return query.split('|||').map(t => t.trim()).filter(t => t.length > 0).map(t => {
        const upper = t.toUpperCase();
        if (['AND', 'OR', 'NOT'].includes(upper)) return upper;
        if (['(', ')'].includes(t)) return t;
        return t.toLowerCase();
    });
}

/** Recursive Descent Parser */
function BooleanParser(tokens) {
    this.tokens = tokens;
    this.pos = 0;
}

BooleanParser.prototype.peek = function() { return this.tokens[this.pos] || null; };
BooleanParser.prototype.consume = function() { return this.tokens[this.pos++]; };

BooleanParser.prototype.parse = function() { return this.parseOr() || { type: 'EMPTY' }; };

BooleanParser.prototype.parseOr = function() {
    let left = this.parseAnd();
    while (this.peek() === 'OR') {
        this.consume();
        left = { type: 'OR', left, right: this.parseAnd() };
    }
    return left;
};

BooleanParser.prototype.parseAnd = function() {
    let left = this.parseNot();
    while (this.peek() === 'AND' || this.peek() === 'NOT') {
        if (this.peek() === 'AND') this.consume();
        left = { type: 'AND', left, right: this.parseNot() };
    }
    return left;
};

BooleanParser.prototype.parseNot = function() {
    if (this.peek() === 'NOT') {
        this.consume();
        return { type: 'NOT', operand: this.parseNot() };
    }
    return this.parsePrimary();
};

BooleanParser.prototype.parsePrimary = function() {
    const tok = this.peek();
    if (!tok) return { type: 'EMPTY' };
    if (tok === '(') {
        this.consume();
        const node = this.parseOr();
        if (this.peek() === ')') this.consume();
        return node;
    }
    this.consume();
    return { type: 'KEYWORD', value: tok };
};

/**
 * AST를 순회하며 검색 결과(fileId의 Set)를 반환
 * @param {Object} node       - AST 노드
 * @param {Map}    keywordMap - keyword → Set<fileId> (서버에서 사전 조회)
 * @param {Set}    allIds     - 전체 fileId Set (NOT 연산용)
 */
function evaluate(node, keywordMap, allIds) {
    if (!node || node.type === 'EMPTY') return new Set();

    if (node.type === 'KEYWORD') {
        return new Set(keywordMap.get(node.value) || []);
    }

    if (node.type === 'OR') {
        const left  = evaluate(node.left,  keywordMap, allIds);
        const right = evaluate(node.right, keywordMap, allIds);
        return new Set([...left, ...right]);
    }

    if (node.type === 'AND') {
        const left = evaluate(node.left, keywordMap, allIds);
        if (left.size === 0) return new Set();
        const right = evaluate(node.right, keywordMap, allIds);
        return new Set([...left].filter(x => right.has(x)));
    }

    if (node.type === 'NOT') {
        const operand = evaluate(node.operand, keywordMap, allIds);
        return new Set([...allIds].filter(x => !operand.has(x)));
    }

    return new Set();
}

module.exports = { tokenize, BooleanParser, evaluate };

# -*- coding: utf-8 -*-
"""
把参考实现 tripledes.py 机械转译成 JS。

为什么不手抄：QQ 音乐的 QRC 用的是「在 PC-2 密钥压缩表上带偏差的自定义 3DES」，
initial_permutation / inverse_permutation / f 加起来近 200 行稠密位运算，
手抄错一个 bit 就全盘解不出来且极难定位。AST 转译可以做到零抄写风险。

语义等价性依据：
  * Python 的 >> 对非负整数是逻辑移位；JS 统一用 >>>（值可能由 <<31 产生负数）
  * & | ^ ~ << 在两边都是 32 位位模式运算，结果一致
  * key_schedule 里 c << shift 会短暂到第 32 位，但紧随的 & 0xFFFFFFF0 会截掉，
    JS 的 << 本来就只有 32 位，结论一致

运行：python scripts/gen-qrc-des.py
"""
import ast
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, ".reference", "tripledes.py")
OUT = os.path.join(ROOT, "src", "main", "qrc-des.js")

BIN_OPS = {
    ast.BitAnd: "&", ast.BitOr: "|", ast.BitXor: "^",
    ast.LShift: "<<", ast.RShift: ">>>",
    ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Mod: "%", ast.Div: "/",
}
UNARY_OPS = {ast.USub: "-", ast.UAdd: "+", ast.Invert: "~"}
CMP_OPS = {ast.Eq: "===", ast.NotEq: "!==", ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">="}


def target_names(node):
    """收集赋值目标里的变量名"""
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Tuple):
        names = []
        for e in node.elts:
            names += target_names(e)
        return names
    return []


def assigned_names(body):
    """收集函数体内被赋值的所有名字（含循环变量）"""
    names = []
    for node in ast.walk(ast.Module(body=body, type_ignores=[])):
        if isinstance(node, (ast.Assign, ast.AugAssign)):
            names += target_names(node.targets[0] if isinstance(node, ast.Assign) else node.target)
        elif isinstance(node, ast.For):
            names += target_names(node.target)
    return names


class Transpiler:
    def __init__(self):
        self.lines = []
        self.depth = 0
        self.locals = set()

    def emit(self, text):
        self.lines.append("  " * self.depth + text)

    # ---------------------------------------------------------- 表达式
    def expr(self, node):
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                return "'" + node.value.replace("\\", "\\\\").replace("'", "\\'") + "'"
            return repr(node.value)
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, (ast.Tuple, ast.List)):
            return "[" + ", ".join(self.expr(e) for e in node.elts) + "]"
        if isinstance(node, ast.BinOp):
            op = type(node.op)
            # Python 的 // 是向下取整除法（这里参与运算的都是非负数）
            if op is ast.FloorDiv:
                return f"Math.trunc({self.expr(node.left)} / {self.expr(node.right)})"
            # Python 的「列表 * n」是重复；JS 的数组 * 是数值乘法，必须单独处理
            if op is ast.Mult:
                left, right = node.left, node.right
                if isinstance(left, ast.List) and isinstance(right, ast.Constant):
                    return f"__repeat({self.expr(left)}, {right.value})"
                if isinstance(right, ast.List) and isinstance(left, ast.Constant):
                    return f"__repeat({self.expr(right)}, {left.value})"
            return f"({self.expr(node.left)} {BIN_OPS[op]} {self.expr(node.right)})"
        if isinstance(node, ast.ListComp):
            gen = node.generators[0]
            if isinstance(gen.iter, ast.Call) and getattr(gen.iter.func, "id", "") == "range":
                count = self.expr(gen.iter.args[0])
                return f"Array.from({{ length: {count} }}, () => {self.expr(node.elt)})"
            raise NotImplementedError(ast.dump(node))
        if isinstance(node, ast.UnaryOp):
            return f"({UNARY_OPS[type(node.op)]}{self.expr(node.operand)})"
        if isinstance(node, ast.Subscript):
            value = self.expr(node.value)
            sl = node.slice
            if isinstance(sl, ast.Slice):
                lower = self.expr(sl.lower) if sl.lower else "0"
                if sl.upper is None and sl.step is None:
                    return f"{value}.slice({lower})"          # key[0:] / key[16:]
                upper = self.expr(sl.upper) if sl.upper else ""
                return f"{value}.slice({lower}, {upper})"
            return f"{value}[{self.expr(sl)}]"
        if isinstance(node, ast.Attribute):
            return f"{self.expr(node.value)}.{node.attr}"
        if isinstance(node, ast.Compare):
            parts = [self.expr(node.left)]
            for op, comp in zip(node.ops, node.comparators):
                parts += [CMP_OPS[type(op)], self.expr(comp)]
            return "(" + " ".join(parts) + ")"
        if isinstance(node, ast.Call):
            fn = self.expr(node.func)
            args = ", ".join(self.expr(a) for a in node.args)
            if fn == "bytearray":
                return f"new Uint8Array({args})" if args else "new Uint8Array(0)"
            return f"{fn}({args})"
        if isinstance(node, ast.IfExp):
            return f"({self.expr(node.test)} ? {self.expr(node.body)} : {self.expr(node.orelse)})"
        raise NotImplementedError(ast.dump(node))

    # ---------------------------------------------------------- 语句
    def stmt(self, node):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            return  # 文档字符串

        if isinstance(node, ast.Assign):
            value = self.expr(node.value)
            target = node.targets[0]
            if isinstance(target, ast.Tuple):
                names = ", ".join(self.expr(e) for e in target.elts)
                self.emit(f"[{names}] = {value};")
            else:
                self.emit(f"{self.expr(target)} = {value};")
            return

        if isinstance(node, ast.AugAssign):
            self.emit(f"{self.expr(node.target)} {BIN_OPS[type(node.op)]}= {self.expr(node.value)};")
            return

        if isinstance(node, ast.For):
            it = node.iter
            if isinstance(it, ast.Call) and getattr(it.func, "id", "") == "range":
                args = [self.expr(a) for a in it.args]
                start, stop, step = ("0", args[0], "1") if len(args) == 1 else \
                                    (args[0], args[1], "1") if len(args) == 2 else tuple(args)
                name = self.expr(node.target)
                self.emit(f"for (let {name} = {start}; {name} < {stop}; {name} += {step}) {{")
            elif isinstance(it, ast.Call) and getattr(it.func, "id", "") == "enumerate":
                idx = node.target.elts[0].id
                val = node.target.elts[1].id
                self.emit(f"{idx} = 0;")
                self.emit(f"for (const {val} of {self.expr(it.args[0])}) {{")
                self.depth += 1
                for s in node.body:
                    self.stmt(s)
                self.emit(f"{idx} += 1;")
                self.depth -= 1
                self.emit("}")
                return
            else:
                raise NotImplementedError(ast.dump(it))
            self.depth += 1
            for s in node.body:
                self.stmt(s)
            self.depth -= 1
            self.emit("}")
            return

        if isinstance(node, ast.If):
            self.emit(f"if ({self.expr(node.test)}) {{")
            self.depth += 1
            for s in node.body:
                self.stmt(s)
            self.depth -= 1
            if node.orelse:
                self.emit("} else {")
                self.depth += 1
                for s in node.orelse:
                    self.stmt(s)
                self.depth -= 1
            self.emit("}")
            return

        if isinstance(node, ast.Return):
            if isinstance(node.value, ast.Tuple):
                self.emit("return [" + ", ".join(self.expr(e) for e in node.value.elts) + "];")
            else:
                self.emit(f"return {self.expr(node.value)};")
            return

        raise NotImplementedError(ast.dump(node))

    def function(self, node):
        params = [a.arg for a in node.args.args]
        tree = ast.Module(body=node.body, type_ignores=[])

        range_vars, enum_vars = set(), set()
        for sub in ast.walk(tree):
            if not isinstance(sub, ast.For):
                continue
            if isinstance(sub.target, ast.Tuple):          # for i, b in enumerate(...)
                enum_vars.add(sub.target.elts[0].id)
            elif isinstance(sub.iter, ast.Call) and getattr(sub.iter.func, "id", "") == "range":
                range_vars.add(sub.target.id)

        inner = {n for n in assigned_names(node.body) if n not in params}
        # range 循环的变量在 for 头部用 let 声明；enumerate 的索引必须提到顶部，
        # 否则 key_schedule 里 i 既当 enumerate 索引又当 range 变量时会漏声明
        declare = sorted((inner | enum_vars) - (range_vars - enum_vars))

        self.emit("")
        self.emit(f"function {node.name}({', '.join(params)}) {{")
        self.depth += 1
        if declare:
            self.emit("let " + ", ".join(declare) + ";")
        for s in node.body:
            self.stmt(s)
        self.depth -= 1
        self.emit("}")
        self.emit("")

    def module_const(self, node):
        def render(value):
            if isinstance(value, (tuple, list)):
                return "[" + ", ".join(render(v) for v in value) + "]"
            return repr(value)
        return render(ast.literal_eval(node.value))


def main():
    tree = ast.parse(io.open(SRC, encoding="utf-8").read())
    tp = Transpiler()

    header = [
        "/*",
        " * QRC 歌词解密用的自定义 Triple-DES（自动生成，请勿手改）",
        " *",
        " * 由 scripts/gen-qrc-des.py 从参考实现机械转译而来。",
        " * QQ 音乐在 PC-2 密钥压缩表上有一处必须照抄的偏差（连 S4 盒都有一个重复值），",
        " * 所以标准库的 DES / 3DES 解不开，必须用这份实现。",
        " *",
        " * 参考：github.com/L-1124/QQMusicApi  algorithms/tripledes.py (GPL-3.0)",
        " *       github.com/WXRIW/QQMusicDecoder  DESHelper.cs",
        " */",
        "'use strict';",
        "",
        "const ENCRYPT = 1;",
        "const DECRYPT = 0;",
        "",
        "/** Python 的「列表 * n」语义：重复 n 次，每次是独立副本 */",
        "function __repeat(arr, n) {",
        "  const out = [];",
        "  for (let i = 0; i < n; i += 1) out.push(arr.slice());",
        "  return out;",
        "}",
        "",
    ]
    for node in tree.body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "sbox":
            header += ["const sbox = " + tp.module_const(node) + ";", ""]
        elif isinstance(node, ast.FunctionDef):
            tp.function(node)

    tail = ["", "module.exports = { ENCRYPT, DECRYPT, tripledes_key_setup, tripledes_crypt };", ""]
    body = "\n".join(header) + "\n".join(tp.lines) + "\n".join(tail)
    io.open(OUT, "w", encoding="utf-8").write(body)
    print("已生成", OUT, "->", len(body), "字节")


if __name__ == "__main__":
    main()

import { RESOURCE_LIMITS } from "./limits.js";
import { AnalysisBudget } from "./resource-budget.js";

interface CharacterClassLiteral {
  readonly kind: "literal";
  readonly value: string;
}

interface CharacterClassRange {
  readonly kind: "range";
  readonly start: string;
  readonly end: string;
}

type CharacterClassAtom = CharacterClassLiteral | CharacterClassRange;

function literal(value: string): CharacterClassLiteral {
  return { kind: "literal", value };
}

function range(start: string, end: string): CharacterClassRange {
  return { end, kind: "range", start };
}

const POSIX_CHARACTER_CLASSES: Readonly<Record<string, readonly CharacterClassAtom[]>> = {
  alpha: [range("A", "Z"), range("a", "z")],
  alnum: [range("A", "Z"), range("a", "z"), range("0", "9")],
  blank: [literal(" "), literal("\t")],
  cntrl: [range("\u0000", "\u001f"), literal("\u007f")],
  digit: [range("0", "9")],
  graph: [range("\u0021", "\u007e")],
  lower: [range("a", "z")],
  print: [range("\u0020", "\u007e")],
  punct: [
    range("\u0021", "\u002f"),
    range("\u003a", "\u0040"),
    range("\u005b", "\u0060"),
    range("\u007b", "\u007e"),
  ],
  space: [
    literal("\t"),
    literal("\n"),
    literal("\v"),
    literal("\f"),
    literal("\r"),
    literal(" "),
  ],
  upper: [range("A", "Z")],
  xdigit: [range("A", "F"), range("a", "f"), range("0", "9")],
};

function foldAsciiCase(value: string): string {
  let folded = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    folded +=
      codePoint >= 0x41 && codePoint <= 0x5a
        ? String.fromCodePoint(codePoint + 0x20)
        : character;
  }
  return folded;
}

function nextCodePoint(value: string, index: number): { readonly nextIndex: number; readonly value: string } | undefined {
  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) {
    return undefined;
  }

  const character = String.fromCodePoint(codePoint);
  return { nextIndex: index + character.length, value: character };
}

interface ParsedPosixClass {
  readonly atoms: readonly CharacterClassAtom[];
  readonly nextIndex: number;
}

function parsePosixClass(pattern: string, index: number): ParsedPosixClass | undefined {
  if (pattern[index] !== "[" || pattern[index + 1] !== ":") {
    return undefined;
  }

  const nameEnd = pattern.indexOf(":]", index + 2);
  if (nameEnd === -1 || pattern[nameEnd + 1] !== "]") {
    return undefined;
  }

  const atoms = POSIX_CHARACTER_CLASSES[pattern.slice(index + 2, nameEnd)];
  if (atoms === undefined) {
    return undefined;
  }

  return {
    atoms,
    nextIndex: nameEnd + 2,
  };
}

interface ParsedBracketExpression {
  readonly atoms: readonly CharacterClassAtom[];
  readonly endIndex: number;
  readonly negated: boolean;
}

interface ParsedBracketElement {
  readonly atoms: readonly CharacterClassAtom[];
  readonly literal?: string;
  readonly nextIndex: number;
}

function parseBracketElement(pattern: string, index: number): ParsedBracketElement | undefined {
  const posixClass = parsePosixClass(pattern, index);
  if (posixClass !== undefined) {
    return { atoms: posixClass.atoms, nextIndex: posixClass.nextIndex };
  }

  const character = pattern[index] ?? "";
  if (character === "[" && pattern[index + 1] === ":") {
    return undefined;
  }

  if (character === "\\") {
    const escaped = nextCodePoint(pattern, index + 1);
    if (escaped === undefined) {
      return undefined;
    }

    return {
      atoms: [literal(escaped.value)],
      literal: escaped.value,
      nextIndex: escaped.nextIndex,
    };
  }

  const codePoint = nextCodePoint(pattern, index);
  if (codePoint === undefined) {
    return undefined;
  }

  return {
    atoms: [literal(codePoint.value)],
    literal: codePoint.value,
    nextIndex: codePoint.nextIndex,
  };
}

function parseBracketExpression(
  pattern: string,
  startIndex: number
): ParsedBracketExpression | undefined {
  let index = startIndex + 1;
  let negated = false;

  if (pattern[index] === "!" || pattern[index] === "^") {
    negated = true;
    index += 1;
  }

  const atoms: CharacterClassAtom[] = [];
  if (pattern[index] === "]") {
    atoms.push(literal("]"));
    index += 1;
  }

  while (index < pattern.length) {
    if (pattern[index] === "]") {
      return { atoms, endIndex: index, negated };
    }

    const start = parseBracketElement(pattern, index);
    if (start === undefined) {
      return undefined;
    }

    if (
      start.literal !== undefined &&
      pattern[start.nextIndex] === "-" &&
      pattern[start.nextIndex + 1] !== undefined &&
      pattern[start.nextIndex + 1] !== "]"
    ) {
      const end = parseBracketElement(pattern, start.nextIndex + 1);
      if (end !== undefined && end.literal !== undefined) {
        const startCodePoint = start.literal.codePointAt(0) ?? 0;
        const endCodePoint = end.literal.codePointAt(0) ?? 0;
        atoms.push(
          startCodePoint > endCodePoint
            ? literal(start.literal)
            : range(start.literal, end.literal)
        );
        index = end.nextIndex;
        continue;
      }
    }

    atoms.push(...start.atoms);
    index = start.nextIndex;
  }

  return undefined;
}

function matchesCharacterClassAtom(
  atom: CharacterClassAtom,
  character: string,
  caseInsensitive: boolean
): boolean {
  const candidate = caseInsensitive ? foldAsciiCase(character) : character;
  if (atom.kind === "literal") {
    const expected = caseInsensitive ? foldAsciiCase(atom.value) : atom.value;
    return candidate === expected;
  }

  const start = caseInsensitive ? foldAsciiCase(atom.start) : atom.start;
  const end = caseInsensitive ? foldAsciiCase(atom.end) : atom.end;
  const candidateCodePoint = candidate.codePointAt(0) ?? -1;
  return (
    candidateCodePoint >= (start.codePointAt(0) ?? 0) &&
    candidateCodePoint <= (end.codePointAt(0) ?? 0)
  );
}

function matchesCharacterClass(
  atoms: readonly CharacterClassAtom[],
  negated: boolean,
  character: string,
  caseInsensitive: boolean
): boolean {
  const matched = atoms.some((atom) =>
    matchesCharacterClassAtom(atom, character, caseInsensitive)
  );
  return negated ? !matched : matched;
}

type PatternToken =
  | {
      readonly atoms: readonly CharacterClassAtom[];
      readonly kind: "character-class";
      readonly negated: boolean;
    }
  | { readonly kind: "directory-wildcard" }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "question" }
  | { readonly kind: "recursive-wildcard" }
  | { readonly kind: "segment-wildcard" };

export class GitattributesPatternResourceLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitattributesPatternResourceLimitError";
  }
}

function globToTokens(pattern: string): readonly PatternToken[] | undefined {
  const tokens: PatternToken[] = [];

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";

    if (character === "\\") {
      const escaped = nextCodePoint(pattern, index + 1);
      if (escaped === undefined) {
        return undefined;
      }

      tokens.push({ kind: "literal", value: escaped.value });
      index = escaped.nextIndex - 1;
      continue;
    }

    if (character === "*") {
      const isDoubleStar = pattern[index + 1] === "*";
      const followsSlash = pattern[index + 2] === "/";
      const isSlashDelimited = index === 0 || pattern[index - 1] === "/";

      if (isDoubleStar && followsSlash && isSlashDelimited) {
        tokens.push({ kind: "directory-wildcard" });
        let nextIndex = index + 3;
        while (
          pattern[nextIndex] === "*" &&
          pattern[nextIndex + 1] === "*" &&
          pattern[nextIndex + 2] === "/"
        ) {
          nextIndex += 3;
        }
        index = nextIndex - 1;
        continue;
      }

      if (
        isDoubleStar &&
        pattern[index + 2] === undefined &&
        pattern[index - 1] === "/"
      ) {
        tokens.push({ kind: "recursive-wildcard" });
        index += 1;
        continue;
      }

      tokens.push({ kind: "segment-wildcard" });
      continue;
    }

    if (character === "?") {
      tokens.push({ kind: "question" });
      continue;
    }

    if (character === "[") {
      const bracketExpression = parseBracketExpression(pattern, index);
      if (bracketExpression === undefined) {
        return undefined;
      }

      tokens.push({
        atoms: bracketExpression.atoms,
        kind: "character-class",
        negated: bracketExpression.negated,
      });
      index = bracketExpression.endIndex;
      continue;
    }

    const codePoint = nextCodePoint(pattern, index);
    if (codePoint === undefined) {
      return undefined;
    }

    tokens.push({ kind: "literal", value: codePoint.value });
    index = codePoint.nextIndex - 1;
  }

  return tokens;
}

function isWildcardToken(token: PatternToken | undefined): boolean {
  return (
    token?.kind === "directory-wildcard" ||
    token?.kind === "recursive-wildcard" ||
    token?.kind === "segment-wildcard"
  );
}

function addEpsilonClosure(
  states: Set<number>,
  tokens: readonly PatternToken[],
  consumeOperation: () => void
): Set<number> {
  const pending = [...states];
  while (pending.length > 0) {
    const state = pending.pop();
    if (state === undefined) {
      continue;
    }

    consumeOperation();
    if (!isWildcardToken(tokens[state])) {
      continue;
    }

    const nextState = state + 1;
    if (!states.has(nextState)) {
      states.add(nextState);
      pending.push(nextState);
    }
  }

  return states;
}

function matchesToken(token: PatternToken, character: string, caseInsensitive: boolean): boolean {
  switch (token.kind) {
    case "character-class":
      return matchesCharacterClass(token.atoms, token.negated, character, caseInsensitive);
    case "literal":
      return (caseInsensitive ? foldAsciiCase(token.value) : token.value) ===
        (caseInsensitive ? foldAsciiCase(character) : character);
    case "question":
      return character !== "/";
    default:
      return false;
  }
}

function matchTokens(
  tokens: readonly PatternToken[],
  pathname: string,
  caseInsensitive: boolean,
  budget: AnalysisBudget | undefined
): boolean {
  let localOperations = 0;
  const consumeOperation = (): void => {
    if (budget !== undefined) {
      budget.consumePatternOperations();
      return;
    }

    localOperations += 1;
    if (localOperations > RESOURCE_LIMITS.maxPatternMatchOperations) {
      throw new GitattributesPatternResourceLimitError(
        `Pattern matching exceeded the ${String(RESOURCE_LIMITS.maxPatternMatchOperations)}-operation budget.`
      );
    }
  };

  let states = addEpsilonClosure(new Set([0]), tokens, consumeOperation);
  for (const character of Array.from(pathname)) {
    if (states.size === 0) {
      return false;
    }

    const nextStates = new Set<number>();
    for (const state of states) {
      const token = tokens[state];
      if (token === undefined) {
        continue;
      }

      consumeOperation();
      if (token.kind === "segment-wildcard" && character !== "/") {
        nextStates.add(state);
      } else if (
        token.kind === "recursive-wildcard" ||
        token.kind === "directory-wildcard"
      ) {
        nextStates.add(state);
        if (token.kind === "directory-wildcard" && character === "/") {
          nextStates.add(state + 1);
        }
      } else if (matchesToken(token, character, caseInsensitive)) {
        nextStates.add(state + 1);
      }
    }

    states = addEpsilonClosure(nextStates, tokens, consumeOperation);
  }

  return addEpsilonClosure(states, tokens, consumeOperation).has(tokens.length);
}

export interface GitattributesPatternOptions {
  readonly budget?: AnalysisBudget;
  readonly caseInsensitive?: boolean;
}

export type GitattributesPatternMatcher = (pathname: string) => boolean;

export function compileGitattributesPattern(
  pattern: string,
  options: GitattributesPatternOptions = {}
): GitattributesPatternMatcher {
  if (pattern.startsWith("/")) {
    return compileNormalizedPattern(pattern.slice(1), options, true);
  }

  return compileNormalizedPattern(pattern, options);
}

function compileNormalizedPattern(
  pattern: string,
  options: GitattributesPatternOptions,
  isRootAnchored = false
): GitattributesPatternMatcher {
  if (pattern.length === 0 || pattern.endsWith("/")) {
    return () => false;
  }

  const tokens = globToTokens(pattern);
  if (tokens === undefined) {
    return () => false;
  }

  const matchesWholePath = isRootAnchored || pattern.includes("/");
  const caseInsensitive = options.caseInsensitive === true;
  return (pathname: string): boolean => {
    const candidate = matchesWholePath ? pathname : (pathname.split("/").at(-1) ?? pathname);
    return matchTokens(tokens, candidate, caseInsensitive, options.budget);
  };
}

export function matchesGitattributesPattern(
  pattern: string,
  pathname: string,
  options: GitattributesPatternOptions = {}
): boolean {
  return compileGitattributesPattern(pattern, options)(pathname);
}

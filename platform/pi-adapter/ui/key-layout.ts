const CYRILLIC = "йцукенгшщзхъфывапролджэячсмитьбюёіїєўЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮЁІЇЄЎ";
const QWERTY = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`s]'oQWERTYUIOP{}ASDFGHJKL:\"ZXCVBNM<>~S}\"O";

const QWERTY_TWINS = new Map(Array.from(CYRILLIC, (letter, index) => [letter, QWERTY[index] ?? letter]));

export const qwertyTwin = (char: string) => QWERTY_TWINS.get(char) ?? char;

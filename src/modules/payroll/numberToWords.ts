/**
 * Converts a numeric amount to Indian Rupee Words
 */
export function numberToWordsIndian(amount: number): string {
  const num = Math.round(amount);
  if (num === 0) return 'Zero Rupees Only';

  const a = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'
  ];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const inWords = (n: number): string => {
    if (n < 20) return a[n];
    const digit = n % 10;
    return b[Math.floor(n / 10)] + (digit ? ' ' + a[digit] : '');
  };

  let str = '';
  let n = num;

  const crores = Math.floor(n / 10000000);
  n %= 10000000;
  const lakhs = Math.floor(n / 100000);
  n %= 100000;
  const thousands = Math.floor(n / 1000);
  n %= 1000;
  const hundreds = Math.floor(n / 100);
  n %= 100;

  if (crores > 0) {
    str += (crores < 20 ? a[crores] : inWords(crores)) + ' Crore ';
  }
  if (lakhs > 0) {
    str += (lakhs < 20 ? a[lakhs] : inWords(lakhs)) + ' Lakh ';
  }
  if (thousands > 0) {
    str += (thousands < 20 ? a[thousands] : inWords(thousands)) + ' Thousand ';
  }
  if (hundreds > 0) {
    str += a[hundreds] + ' Hundred ';
  }
  if (n > 0) {
    str += inWords(n) + ' ';
  }

  return str.trim() + ' Rupees Only';
}

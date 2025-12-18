import java.math.BigInteger;
import java.math.BigDecimal;

public class Int38Parser {

    // 解析单个字段
    public static BigInteger parseInt38(String hexString) {
        // 将十六进制字符串转为二进制字符串
        String binaryString = new BigInteger(hexString, 16).toString(2);

        // 确保二进制字符串长度为 40 位（前导补 0）
        while (binaryString.length() < 40) {
            binaryString = "0" + binaryString;
        }

        // 跳过前 2 位，取后 38 位
        String effectiveBits = binaryString.substring(2);

        // 将 38 位有效数据转为整数
        BigInteger value = new BigInteger(effectiveBits, 2);

        // 检查是否是负数 (第 38 位为符号位)
        if (effectiveBits.charAt(0) == '1') {
            // 如果是负数，进行补码处理：value - 2^38
            BigInteger negativeOffset = BigInteger.valueOf(1L).shiftLeft(38);
            value = value.subtract(negativeOffset);
        }


        // 先将BigInteger转为BigDecimal做除法，保留小数
        //BigDecimal result = new BigDecimal(value).divide(new BigDecimal(1000));
        return value;
    }

    public static void main(String[] args) {
        // 从命令行参数读取输入字符串
        if (args.length < 1) {
            System.out.println("用法: java Int38Parser <十六进制字符串>");
            System.out.println("示例: java Int38Parser d300133ed67c033c5307b45e8d08fe4ced0612be95f97c970c");
            return;
        }
        
        String input = args[0];

        // 提取各字段
        String ecefXHex = input.substring(14, 24); // 第 11 到 20 个字符
        String ecefYHex = input.substring(24, 34); // 第 21 到 30 个字符
        String ecefZHex = input.substring(34, 44); // 第 31 到 40 个字符

        // 解析每个字段
        double ecefX = parseInt38(ecefXHex).doubleValue() / 10000;
        double ecefY = parseInt38(ecefYHex).doubleValue() / 10000 ;
        double ecefZ = parseInt38(ecefZHex).doubleValue() / 10000;

        // 输出结果
        System.out.println("ECEF_X: " + ecefX);
        System.out.println("ECEF_Y: " + ecefY);
        System.out.println("ECEF_Z: " + ecefZ);
    }
}

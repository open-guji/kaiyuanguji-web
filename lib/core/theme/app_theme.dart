import 'package:flutter/material.dart';

/// 应用主题配置
/// 实现古籍风格的视觉设计系统
class AppTheme {
  // 禁止实例化
  AppTheme._();

  // 字体栈：优先使用系统自带的宋体，实现快速加载且零网络依赖
  static const List<String> fontFallbacks = [
    'SimSun',
    'Songti SC',
    'STSong',
    'Noto Serif SC',
    'serif',
  ];

  /// 宣纸色背景（米黄色，缓解长时间阅读疲劳）
  static const Color paperBackground = Color(0xFFF5F2E9);

  /// 墨黑色文字
  static const Color inkBlack = Color(0xFF2C2C2C);

  /// 朱砂红强调色（用于按钮、重点节点）
  static const Color vermilionRed = Color(0xFF8B0000);

  /// 浅灰色（用于次要文本）
  static const Color secondaryGray = Color(0xFF666666);

  /// 边框颜色
  static const Color borderColor = Color(0xFFD4CFC0);

  /// 获取应用的 ThemeData
  static ThemeData get themeData {
    return ThemeData(
      // 基础颜色方案
      colorScheme: ColorScheme.light(
        primary: vermilionRed,
        onPrimary: paperBackground,
        secondary: inkBlack,
        onSecondary: paperBackground,
        surface: paperBackground,
        onSurface: inkBlack,
      ),

      // 脚手架背景色
      scaffoldBackgroundColor: paperBackground,

      // 应用栏主题
      appBarTheme: AppBarTheme(
        backgroundColor: paperBackground,
        foregroundColor: inkBlack,
        elevation: 0,
        centerTitle: true,
        titleTextStyle: const TextStyle(
          fontSize: 20,
          fontWeight: FontWeight.w600,
          color: inkBlack,
          letterSpacing: 2.0,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
      ),

      // 文本主题 - 使用系统宋体
      textTheme: const TextTheme(
        displayLarge: TextStyle(
          fontSize: 32,
          fontWeight: FontWeight.bold,
          color: inkBlack,
          height: 1.5,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
        displayMedium: TextStyle(
          fontSize: 28,
          fontWeight: FontWeight.bold,
          color: inkBlack,
          height: 1.5,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
        displaySmall: TextStyle(
          fontSize: 24,
          fontWeight: FontWeight.bold,
          color: inkBlack,
          height: 1.5,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
        headlineLarge: TextStyle(
          fontSize: 22,
          fontWeight: FontWeight.w600,
          color: inkBlack,
          height: 1.6,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
        headlineMedium: TextStyle(
          fontSize: 20,
          fontWeight: FontWeight.w600,
          color: inkBlack,
          height: 1.6,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
        headlineSmall: TextStyle(
          fontSize: 18,
          fontWeight: FontWeight.w600,
          color: inkBlack,
          height: 1.6,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
        bodyLarge: TextStyle(
          fontSize: 16,
          fontWeight: FontWeight.normal,
          color: inkBlack,
          height: 1.8,
          letterSpacing: 0.5,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
        bodyMedium: TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.normal,
          color: inkBlack,
          height: 1.8,
          letterSpacing: 0.5,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
        bodySmall: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.normal,
          color: secondaryGray,
          height: 1.6,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
        labelLarge: TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w500,
          color: inkBlack,
          fontFamily: 'SimSun',
          fontFamilyFallback: fontFallbacks,
        ),
      ),

      // 卡片主题
      cardTheme: CardThemeData(
        color: paperBackground,
        elevation: 2,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: BorderSide(color: borderColor, width: 1),
        ),
      ),

      // 分割线主题
      dividerTheme: DividerThemeData(
        color: borderColor,
        thickness: 1,
        space: 24,
      ),

      // 图标主题
      iconTheme: IconThemeData(
        color: inkBlack,
        size: 24,
      ),

      // 按钮主题
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: vermilionRed,
          foregroundColor: paperBackground,
          elevation: 2,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(4),
          ),
          textStyle: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            fontFamily: 'SimSun',
            fontFamilyFallback: fontFallbacks,
          ),
        ),
      ),

      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: vermilionRed,
          textStyle: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            fontFamily: 'SimSun',
            fontFamilyFallback: fontFallbacks,
          ),
        ),
      ),
    );
  }

  /// 获取响应式的内容最大宽度
  static double getContentMaxWidth(BuildContext context) {
    final screenWidth = MediaQuery.of(context).size.width;
    if (screenWidth > 1200) {
      return 800; // 桌面端
    } else if (screenWidth > 600) {
      return 600; // 平板
    } else {
      return screenWidth * 0.9; // 手机端
    }
  }

  /// 获取响应式的内容边距
  static EdgeInsets getContentPadding(BuildContext context) {
    final screenWidth = MediaQuery.of(context).size.width;
    if (screenWidth > 1200) {
      return const EdgeInsets.all(48);
    } else if (screenWidth > 600) {
      return const EdgeInsets.all(32);
    } else {
      return const EdgeInsets.all(16);
    }
  }
}

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../../../core/theme/app_theme.dart';
import 'section_header.dart';

/// 古籍索引导向板块
class BookIndexSection extends StatelessWidget {
  const BookIndexSection({super.key});

  @override
  Widget build(BuildContext context) {
    final isMobile = MediaQuery.of(context).size.width < 600;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
      color: AppTheme.paperBackground,
      child: Column(
        children: [
          SectionHeader(
            title: '古籍索引',
            subtitle: '标准化的古籍数字资源索引系统',
            onTap: () => context.go('/book-index'),
          ),
          const SizedBox(height: 32),
          Container(
            constraints: const BoxConstraints(maxWidth: 900),
            padding: const EdgeInsets.all(32),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: AppTheme.borderColor.withValues(alpha: 0.5),
              ),
              boxShadow: [
                BoxShadow(
                  color: AppTheme.inkBlack.withValues(alpha: 0.03),
                  blurRadius: 30,
                  offset: const Offset(0, 10),
                ),
              ],
            ),
            child: isMobile ? _buildMobileContent(context) : _buildDesktopContent(context),
          ),
        ],
      ),
    );
  }

  Widget _buildDesktopContent(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '作品 · 丛编 · 书籍',
                style: TextStyle(
                  color: AppTheme.vermilionRed,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1.2,
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                '古籍索引建立了一套标准化的ID体系，用于解决古籍数字化中的层级分类和版本关联问题。支持作品、丛编、书三个层级，实现古籍资源的统一检索与管理。',
                style: TextStyle(
                  color: AppTheme.inkBlack,
                  fontSize: 18,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 24),
              _buildFeatureList(),
            ],
          ),
        ),
        const SizedBox(width: 40),
        ElevatedButton(
          onPressed: () => context.go('/book-index'),
          style: ElevatedButton.styleFrom(
            backgroundColor: AppTheme.vermilionRed,
            foregroundColor: Colors.white,
            padding: const EdgeInsets.symmetric(
              horizontal: 32,
              vertical: 20,
            ),
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(8),
            ),
          ),
          child: const Text('浏览索引'),
        ),
      ],
    );
  }

  Widget _buildMobileContent(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          '作品 · 丛编 · 书籍',
          style: TextStyle(
            color: AppTheme.vermilionRed,
            fontWeight: FontWeight.bold,
            letterSpacing: 1.2,
          ),
        ),
        const SizedBox(height: 16),
        const Text(
          '古籍索引建立了一套标准化的ID体系，用于解决古籍数字化中的层级分类和版本关联问题。支持作品、丛编、书三个层级，实现古籍资源的统一检索与管理。',
          style: TextStyle(
            color: AppTheme.inkBlack,
            fontSize: 16,
            height: 1.6,
          ),
        ),
        const SizedBox(height: 24),
        _buildFeatureList(),
        const SizedBox(height: 24),
        SizedBox(
          width: double.infinity,
          child: ElevatedButton(
            onPressed: () => context.go('/book-index'),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppTheme.vermilionRed,
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(vertical: 16),
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
            ),
            child: const Text('浏览索引'),
          ),
        ),
      ],
    );
  }

  Widget _buildFeatureList() {
    return Row(
      children: [
        _buildFeatureChip(Icons.auto_stories, '作品'),
        const SizedBox(width: 12),
        _buildFeatureChip(Icons.library_books, '丛编'),
        const SizedBox(width: 12),
        _buildFeatureChip(Icons.menu_book, '书籍'),
      ],
    );
  }

  Widget _buildFeatureChip(IconData icon, String label) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: AppTheme.paperBackground,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: AppTheme.secondaryGray),
          const SizedBox(width: 6),
          Text(
            label,
            style: const TextStyle(
              fontSize: 13,
              color: AppTheme.secondaryGray,
            ),
          ),
        ],
      ),
    );
  }
}

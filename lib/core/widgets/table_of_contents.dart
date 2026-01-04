import 'package:flutter/material.dart';
import '../content/toc_extractor.dart';
import '../theme/app_theme.dart';

/// 目录组件
/// 显示页面的标题结构，方便用户快速浏览
class TableOfContents extends StatelessWidget {
  /// 目录项列表
  final List<TocItem> items;

  /// 当前激活的索引（可选）
  final int? activeIndex;

  /// 点击目录项的回调（可选）
  final void Function(TocItem item)? onTap;

  const TableOfContents({
    super.key,
    required this.items,
    this.activeIndex,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return const SizedBox.shrink();
    }

    return Container(
      width: 240,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.paperBackground,
        border: Border(
          left: BorderSide(
            color: AppTheme.borderColor,
            width: 1,
          ),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 标题
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Text(
              '目录',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    letterSpacing: 1.0,
                  ),
            ),
          ),

          // 目录列表
          Expanded(
            child: ListView.builder(
              itemCount: items.length,
              itemBuilder: (context, index) {
                final item = items[index];
                final isActive = activeIndex == item.index;

                return _buildTocItem(context, item, isActive);
              },
            ),
          ),
        ],
      ),
    );
  }

  /// 构建单个目录项
  Widget _buildTocItem(BuildContext context, TocItem item, bool isActive) {
    // 根据标题级别计算缩进
    final indent = (item.level - 1) * 12.0;

    return InkWell(
      onTap: onTap != null ? () => onTap!(item) : null,
      child: Container(
        padding: EdgeInsets.only(
          left: indent,
          top: 6,
          bottom: 6,
          right: 8,
        ),
        decoration: isActive
            ? BoxDecoration(
                color: AppTheme.vermilionRed.withValues(alpha: 0.05),
                borderRadius: BorderRadius.circular(4),
              )
            : null,
        child: Row(
          children: [
            // 级别指示器（仅对 h2 及以下显示）
            if (item.level > 1)
              Container(
                width: 4,
                height: 4,
                margin: const EdgeInsets.only(right: 8),
                decoration: BoxDecoration(
                  color: isActive
                      ? AppTheme.vermilionRed
                      : AppTheme.secondaryGray,
                  shape: BoxShape.circle,
                ),
              ),

            // 标题文本
            Expanded(
              child: Text(
                item.title,
                style: TextStyle(
                  fontSize: item.level == 1 ? 14 : 13,
                  fontWeight: item.level == 1
                      ? FontWeight.w600
                      : (isActive ? FontWeight.w500 : FontWeight.normal),
                  color: isActive ? AppTheme.vermilionRed : AppTheme.inkBlack,
                  height: 1.4,
                ),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

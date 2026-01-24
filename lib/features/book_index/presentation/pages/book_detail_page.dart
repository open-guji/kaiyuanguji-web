import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/layout/layout_shell.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../core/theme/markdown_theme.dart';
import '../../data/book_index_model.dart';
import '../../data/book_index_service.dart';

/// 古籍详情页
/// 展示单个古籍的 Markdown 内容
class BookDetailPage extends StatefulWidget {
  final String bookId;

  const BookDetailPage({super.key, required this.bookId});

  @override
  State<BookDetailPage> createState() => _BookDetailPageState();
}

class _BookDetailPageState extends State<BookDetailPage> {
  BookIndexItem? _bookItem;
  String? _content;
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadBookDetail();
  }

  Future<void> _loadBookDetail() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      // 先查找书籍信息
      final item = await BookIndexService.findBookById(widget.bookId);
      if (item == null) {
        setState(() {
          _error = '未找到该古籍: ${widget.bookId}';
          _isLoading = false;
        });
        return;
      }

      // 获取内容
      final content = await BookIndexService.fetchBookContent(item);
      setState(() {
        _bookItem = item;
        _content = content;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _error = '加载失败: $e';
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final isMobile = MediaQuery.of(context).size.width < 600;

    return LayoutShell(
      title: _bookItem?.name ?? '古籍详情',
      child: SingleChildScrollView(
        padding: EdgeInsets.all(isMobile ? 16 : 32),
        child: Center(
          child: Container(
            constraints: const BoxConstraints(maxWidth: 800),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _buildBreadcrumb(context),
                const SizedBox(height: 24),
                _buildContent(context),
                const SizedBox(height: 48),
                LayoutShell.buildFooter(context),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildBreadcrumb(BuildContext context) {
    return Row(
      children: [
        InkWell(
          onTap: () => context.go('/book-index'),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.arrow_back,
                size: 16,
                color: AppTheme.vermilionRed,
              ),
              const SizedBox(width: 4),
              Text(
                '返回索引',
                style: TextStyle(
                  color: AppTheme.vermilionRed,
                  fontSize: 14,
                ),
              ),
            ],
          ),
        ),
        if (_bookItem != null) ...[
          const SizedBox(width: 16),
          Container(
            width: 1,
            height: 16,
            color: AppTheme.borderColor,
          ),
          const SizedBox(width: 16),
          _buildTag(_bookItem!.typeLabel, _getTypeColor()),
          const SizedBox(width: 8),
          _buildTag(
            _bookItem!.statusLabel,
            _bookItem!.isDraft ? AppTheme.secondaryGray : Colors.green,
          ),
        ],
      ],
    );
  }

  Widget _buildTag(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          color: color,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }

  Color _getTypeColor() {
    if (_bookItem == null) return AppTheme.vermilionRed;
    switch (_bookItem!.type) {
      case BookResourceType.work:
        return Colors.blue;
      case BookResourceType.collection:
        return Colors.purple;
      case BookResourceType.book:
        return AppTheme.vermilionRed;
    }
  }

  Widget _buildContent(BuildContext context) {
    if (_isLoading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(48),
          child: Column(
            children: [
              CircularProgressIndicator(color: AppTheme.vermilionRed),
              SizedBox(height: 16),
              Text('正在加载内容...'),
            ],
          ),
        ),
      );
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(48),
          child: Column(
            children: [
              const Icon(Icons.error_outline, size: 48, color: AppTheme.vermilionRed),
              const SizedBox(height: 16),
              Text(_error!, style: const TextStyle(color: AppTheme.vermilionRed)),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  ElevatedButton(
                    onPressed: _loadBookDetail,
                    child: const Text('重试'),
                  ),
                  const SizedBox(width: 16),
                  OutlinedButton(
                    onPressed: () => context.go('/book-index'),
                    child: const Text('返回索引'),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(32),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.borderColor),
        boxShadow: [
          BoxShadow(
            color: AppTheme.inkBlack.withValues(alpha: 0.03),
            blurRadius: 20,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ID 信息
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: AppTheme.paperBackground,
              borderRadius: BorderRadius.circular(4),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.fingerprint,
                  size: 14,
                  color: AppTheme.secondaryGray,
                ),
                const SizedBox(width: 6),
                Text(
                  'ID: ${widget.bookId}',
                  style: TextStyle(
                    fontSize: 12,
                    fontFamily: 'monospace',
                    color: AppTheme.secondaryGray,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          // Markdown 内容
          MarkdownBody(
            data: _content ?? '',
            styleSheet: MarkdownTheme.getStyleSheet(context),
            selectable: true,
          ),
        ],
      ),
    );
  }
}

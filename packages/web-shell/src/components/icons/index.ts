/**
 * Icon module — single import point for every glyph the shell renders.
 *
 * Default source is Lucide (`lucide-preact`). Curated re-exports keep
 * the import surface small and let us swap any one icon for a custom
 * SVG later by replacing a single line here. Brand-specific marks
 * (today: just the heptagon) live alongside as local files.
 *
 * Add icons here as you need them — don't import from `lucide-preact`
 * directly in components, so this file remains the registry of every
 * glyph the shell uses.
 */

export {
  AlertCircle,
  AlertTriangle,
  AtSign,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Copy,
  Download,
  Eye,
  Folder,
  Hash,
  Home,
  Inbox,
  Info,
  LogOut,
  Menu,
  MessageCircle,
  Monitor,
  Moon,
  PanelRight,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Slash,
  Sun,
  Target,
  Users,
  Wand2,
  WifiOff,
  X,
} from 'lucide-preact';

export { BrandMark } from './BrandMark.js';

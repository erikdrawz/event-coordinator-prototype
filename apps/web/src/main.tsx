import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource/figtree/800.css';
import './styles/base.css';
import './styles/components.css';
import { AuthProvider } from './lib/auth';
import { App } from './App';

// A data router (one catch-all route; App keeps its own <Routes>) so pages can use useBlocker for unsaved changes
const router = createBrowserRouter([{ path: '*', element: <AuthProvider><App /></AuthProvider> }]);

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

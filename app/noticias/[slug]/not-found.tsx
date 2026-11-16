import { Container } from "@/components/ui/container";
import { ArticleNavigation } from "@/components/news/article/article-navigation";
import { SiteFooter } from "@/components/footer/site-footer";

export default function ArticleNotFound() {
  return (
    <div className="article-page min-h-screen">
      <ArticleNavigation />
      <main id="contenido">
        <Container className="py-10 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <h1 className="type-h2">Esta noticia no está disponible</h1>
            <p className="mt-4 text-muted-foreground">Puede que la dirección no sea correcta o que la publicación ya no esté disponible públicamente.</p>
          </div>
        </Container>
      </main>
      <SiteFooter />
    </div>
  );
}
